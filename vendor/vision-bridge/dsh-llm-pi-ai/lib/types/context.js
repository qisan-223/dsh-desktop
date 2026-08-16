/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */
import { CallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm';
import { toPiAssistant } from "./replay.js";
/** Convert bridge-described images into text for a text-only pi-ai model. */
function blockText(block) {
    if (block.type === 'text')
        return block.text;
    if (block.type === 'image')
        return block.description === undefined ? '' : `[图片内容]\n${block.description}`;
    if (block.type === 'tool-result')
        return toolResultText(block.content);
    return '';
}
/** Join direct text and hidden vision-bridge descriptions from one harness message. */
function flattenText(message) {
    return message.content
        .filter(block => block.type !== 'tool-result')
        .map(blockText)
        .join('');
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
    return blocks.map(blockText).join('');
}
/** True when a content tree still contains an image without a bridge description. */
export function contentHasUndescribedImage(content) {
    return content.some(block => (block.type === 'image' && block.description === undefined)
        || (block.type === 'tool-result' && contentHasUndescribedImage(block.content)));
}
function foldBlock(block) {
    if (block.type === 'image' && block.description !== undefined) {
        return { type: 'text', text: `[图片内容]\n${block.description}` };
    }
    if (block.type === 'tool-result')
        return { ...block, content: block.content.map(foldBlock) };
    return block;
}
/** Replace bridge-described images with text before a text-only provider sees them. */
export function foldDescribedImages(messages) {
    return messages.map(message => ({ ...message, content: message.content.map(foldBlock) }));
}
async function userContent(blocks, attachments) {
    const content = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                if (block.text.length > 0)
                    content.push({ type: 'text', text: block.text });
                break;
            case 'image': {
                const stored = await attachments.readImage(block.attachment);
                content.push({
                    type: 'image',
                    data: Buffer.from(stored.data).toString('base64'),
                    mimeType: stored.ref.mediaType,
                });
                break;
            }
            case 'tool-result':
                {
                    const nested = await userContent(block.content, attachments);
                    if (typeof nested === 'string') {
                        if (nested.length > 0)
                            content.push({ type: 'text', text: nested });
                    }
                    else {
                        content.push(...nested);
                    }
                }
                break;
            default:
                // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
                break;
        }
    }
    if (content.every(block => block.type === 'text'))
        return content.map(block => block.text).join('');
    return content;
}
function toolsOf(options) {
    return options.tools?.map(tool => ({
        name: tool.name,
        description: tool.description,
        // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
        // (TypeBox) is structurally JSON Schema, so it assigns directly.
        parameters: tool.parameters,
    }));
}
/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options, messages) {
    const tools = toolsOf(options);
    return {
        ...options.system !== undefined ? { systemPrompt: options.system } : {},
        messages,
        ...tools !== undefined && tools.length > 0 ? { tools } : {},
    };
}
function textOnlyContext(options) {
    const toolNames = new Map();
    const messages = [];
    for (const message of options.messages) {
        if (contentHasImage(message.content)) {
            throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT');
        }
        if (message.role === 'system') {
            messages.push({ role: 'user', content: flattenText(message), timestamp: 0 });
            continue;
        }
        if (message.role === 'assistant') {
            const assistant = toPiAssistant(message);
            for (const block of assistant.content)
                if (block.type === 'toolCall')
                    toolNames.set(CallId(block.id), block.name);
            messages.push(assistant);
            continue;
        }
        const text = flattenText(message);
        const results = message.content.filter(block => block.type === 'tool-result');
        if (text.length > 0 || results.length === 0)
            messages.push({ role: 'user', content: text, timestamp: 0 });
        for (const result of results) {
            messages.push({
                role: 'toolResult',
                toolCallId: result.toolCallId,
                toolName: toolNames.get(result.toolCallId) ?? 'unknown',
                content: [{
                        type: 'text',
                        text: toolResultText(result.content) || '(no output)',
                    }],
                isError: result.isError ?? false,
                timestamp: 0,
            });
        }
    }
    return piContext(options, messages);
}
export function toPiContext(options, attachments) {
    return attachments === undefined ? textOnlyContext(options) : toPiContextWithImages(options, attachments);
}
async function toPiContextWithImages(options, attachments) {
    const toolNames = new Map();
    const messages = [];
    for (const message of options.messages) {
        if (message.role === 'system') {
            if (contentHasImage(message.content)) {
                throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT');
            }
            // pi-ai has a single systemPrompt slot; in-history system messages are
            // folded into user messages to preserve order (rare in practice — the
            // harness sends the system prompt via options.system).
            messages.push({ role: 'user', content: flattenText(message), timestamp: 0 });
            continue;
        }
        if (message.role === 'assistant') {
            const assistant = toPiAssistant(message);
            for (const block of assistant.content) {
                if (block.type === 'toolCall')
                    toolNames.set(CallId(block.id), block.name);
            }
            messages.push(assistant);
            continue;
        }
        // user role: text + tool results (each result becomes its own message).
        const regular = message.content.filter(block => block.type !== 'tool-result');
        const content = await userContent(regular, attachments);
        const results = message.content.filter(block => block.type === 'tool-result');
        if (content.length > 0 || results.length === 0) {
            messages.push({ role: 'user', content, timestamp: 0 });
        }
        for (const result of results) {
            const resultContent = await userContent(result.content, attachments);
            messages.push({
                role: 'toolResult',
                toolCallId: result.toolCallId,
                toolName: toolNames.get(result.toolCallId) ?? 'unknown',
                content: typeof resultContent === 'string'
                    ? [{ type: 'text', text: resultContent || '(no output)' }]
                    : resultContent,
                isError: result.isError ?? false,
                timestamp: 0,
            });
        }
    }
    return piContext(options, messages);
}
//# sourceMappingURL=context.js.map