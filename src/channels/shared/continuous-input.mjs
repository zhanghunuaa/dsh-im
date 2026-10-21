import { t } from './i18n.mjs';

// Continuous input (the ready/go protocol) is the WeCom-specific sibling of
// ./batch-input.mjs. The difference that matters:
//
//   1. It is triggered by message *content* (a message that is exactly
//      "ready" / "go" / "cancel") instead of slash commands, so a client that
//      cannot or should not type "/batch" can still pre-compose one turn. The
//      cancel word is deliberately NOT "/cancel": that slash command belongs to
//      ./batch-input.mjs, and sharing it made the two state machines fight over
//      the same message.
//   2. A collected entry is the whole inbound message (text, images, files and
//      quoted content), not just text. The bridge prepares each entry when it
//      arrives so Enterprise WeChat's short-lived media URLs are fetched
//      immediately instead of after the user sends "go".
//
// The state machine mirrors BatchInputManager deliberately: same phases
// (idle/collecting/submitting), same "complete/fail keeps the batch on a retry"
// contract, so the bridge can settle both managers through one code path.
export const CONTINUOUS_INPUT_MESSAGE_LIMIT = 50;
export const CONTINUOUS_INPUT_IMAGE_LIMIT = 8;
export const CONTINUOUS_INPUT_FILE_LIMIT = 8;

const READY_TEXT = 'ready';
const GO_TEXT = 'go';
// The ready/go collector owns the bare word "cancel"; "/cancel" stays the
// /batch command and is only answered with a hint while the collector is open.
const CANCEL_TEXT = 'cancel';
const SEND_COMMAND = /^\/send$/iu;
const CANCEL_COMMAND = /^\/cancel$/iu;
const BATCH_COMMAND = /^\/batch$/iu;

function result(kind, message, extra = {}) {
  return { handled: true, kind, ...(message ? { message } : {}), ...extra };
}

/**
 * The ready/go marker carried by one message. Matching is exact (after
 * trimming) and case-insensitive, so "go ahead" or "ready?" stay ordinary
 * messages and only the bare words switch modes.
 */
export function readyGoMarker(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().toLowerCase();
  if (normalized === READY_TEXT || normalized === GO_TEXT || normalized === CANCEL_TEXT) {
    return normalized;
  }
  return null;
}

/**
 * A batch starts its own DSH Session: the first "ready" also performs the /new
 * command, so the collected content can never inherit the previous turn's
 * context. The acknowledgement says so explicitly.
 */
export function continuousInputStartedMessage() {
  return t(`已进入连续消息收集模式，并已自动开启新会话（等效发送 /new），本次 go 提交会进入这个新会话。
最多可收集 {messages} 条消息（图片 {images} 张、文件 {files} 个）。
发送 go 后统一处理；也可以发送 /send 提前提交，发送 cancel 取消。`, {
    messages: CONTINUOUS_INPUT_MESSAGE_LIMIT,
    images: CONTINUOUS_INPUT_IMAGE_LIMIT,
    files: CONTINUOUS_INPUT_FILE_LIMIT,
  });
}

/** The reset failed, but collection still starts and the submit retries it. */
export function continuousInputNewSessionFailedMessage() {
  return t(`已进入连续消息收集模式，但自动开启新会话失败；提交时还会再尝试一次。
最多可收集 {messages} 条消息（图片 {images} 张、文件 {files} 个）。
发送 go 后统一处理；也可以发送 /send 提前提交，发送 cancel 取消。`, {
    messages: CONTINUOUS_INPUT_MESSAGE_LIMIT,
    images: CONTINUOUS_INPUT_IMAGE_LIMIT,
    files: CONTINUOUS_INPUT_FILE_LIMIT,
  });
}

export function continuousInputBusyMessage() {
  return t(`当前聊天有正在运行的任务、待回答问题或待审批请求。
请先完成当前交互或发送 /stop，再发送 ready 开始连续消息收集。`);
}

export function continuousInputEmptyMessage() {
  return t('当前还没有收集到内容，请先发送文字、图片或文件，或发送 cancel 取消。');
}

export function continuousInputUnsupportedMarkerMessage() {
  return t('ready 需要以纯文字发送，请移除图片、文件或引用后重试。');
}

export function continuousInputGroupUnsupportedMessage() {
  return t('连续消息收集仅支持私聊，请在与机器人的私聊中使用。');
}

function progressMessage(batch) {
  return t(`当前正在收集连续消息，已收集 {count}/{limit} 条（图片 {images}/{imageLimit} 张，文件 {files}/{fileLimit} 个）。
发送 go 统一处理，/send 提前提交，cancel 取消。`, {
    count: batch.items.length,
    limit: CONTINUOUS_INPUT_MESSAGE_LIMIT,
    images: batch.imageCount,
    imageLimit: CONTINUOUS_INPUT_IMAGE_LIMIT,
    files: batch.fileCount,
    fileLimit: CONTINUOUS_INPUT_FILE_LIMIT,
  });
}

function itemLabel(index, { imageCount = 0, fileCount = 0 } = {}) {
  const tags = [];
  if (imageCount > 0) tags.push(t('图片 {count} 张', { count: imageCount }));
  if (fileCount > 0) tags.push(t('文件 {count} 个', { count: fileCount }));
  const label = t('[消息 {index}]', { index: index + 1 });
  return tags.length > 0 ? `${label}（${tags.join('，')}）` : label;
}

function attachmentPlaceholder() {
  return t('（本条为附件消息，附件已按顺序附在本次输入中。）');
}

/**
 * Compose the single prompt the model receives. Text keeps the message order;
 * images/files are handed to the same turn as attachment arrays, so the labels
 * tell the model how the attachments map onto the numbered messages.
 */
export function continuousInputPrompt(items) {
  const sections = items.map((item, index) => {
    const label = itemLabel(index, item);
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const body = text || (item.imageCount > 0 || item.fileCount > 0
      ? attachmentPlaceholder()
      : '');
    return `${label}\n${body}`;
  });
  return [
    t('以下是用户通过连续消息（先发送 ready，逐条发送内容，最后发送 go）发送的多条内容，请按顺序作为同一次输入统一处理。'),
    ...sections,
  ].join('\n\n');
}

function submissionTitle(items) {
  return items.find((item) => typeof item.text === 'string' && item.text.trim())?.text.trim() ?? '';
}

function countsOf(batch) {
  return {
    count: batch.items.length,
    imageCount: batch.imageCount,
    fileCount: batch.fileCount,
  };
}

export class ContinuousInputManager {
  #batches = new Map();

  status(key) {
    const batch = this.#batches.get(key);
    if (!batch) {
      return Object.freeze({
        phase: 'idle',
        count: 0,
        imageCount: 0,
        fileCount: 0,
      });
    }
    return Object.freeze({ phase: batch.phase, ...countsOf(batch) });
  }

  /**
   * Handle one inbound direct message.
   *
   * `buildContent` is only invoked for entries the manager keeps; the bridge
   * uses it to hand over the prefetched inbound message (already-started media
   * downloads) without the manager needing to know about WeCom frames.
   */
  handle(key, {
    text = '',
    marker = null,
    plainText = false,
    imageCount = 0,
    fileCount = 0,
    hasContent = false,
    buildContent = null,
  } = {}) {
    const batch = this.#batches.get(key);
    const commandText = typeof text === 'string' ? text.trim() : '';

    if (!batch) {
      if (marker !== 'ready') return { handled: false };
      if (!plainText) {
        return result('unsupported-content', continuousInputUnsupportedMarkerMessage());
      }
      this.#batches.set(key, {
        phase: 'collecting',
        items: [],
        token: null,
        imageCount: 0,
        fileCount: 0,
      });
      return result('started', continuousInputStartedMessage());
    }

    if (batch.phase === 'submitting') {
      if (marker || SEND_COMMAND.test(commandText) || CANCEL_COMMAND.test(commandText)
        || BATCH_COMMAND.test(commandText)) {
        return result('submitting', t('上一批连续消息正在处理中，请稍候。'));
      }
      // Everything else may still steer the running turn like any other
      // message; the collector must not swallow it.
      return { handled: false };
    }

    if (marker === 'ready') return result('status', progressMessage(batch), countsOf(batch));
    if (marker === 'go') return this.#submit(key, batch);
    if (marker === 'cancel') {
      if (!plainText) {
        return result('unsupported-content', t('cancel 需要以纯文字发送，请移除图片、文件或引用后重试。'));
      }
      const count = batch.items.length;
      this.#batches.delete(key);
      return result('cancelled', count === 0
        ? t('已取消连续消息收集，当前没有收集到内容。')
        : t('已取消连续消息收集，共丢弃 {count} 条消息。', { count }), { count });
    }
    if (SEND_COMMAND.test(commandText)) return this.#submit(key, batch);
    if (CANCEL_COMMAND.test(commandText)) {
      // "/cancel" belongs to the /batch state machine. The collector answers it
      // with the word it actually owns instead of acting on it, so the two
      // protocols can never disagree about which one handled a message.
      return result('blocked-command', t('连续消息收集请发送 cancel（不带斜杠）取消，或发送 go 提交。'), countsOf(batch));
    }
    if (BATCH_COMMAND.test(commandText)) {
      return result('status', progressMessage(batch), countsOf(batch));
    }
    if (commandText.startsWith('/')) {
      return result('blocked-command', t('当前正在收集连续消息，请先发送 go 提交或发送 cancel 取消。'), countsOf(batch));
    }
    if (!hasContent) {
      return result('unsupported-content', t('这条消息没有可收集的文字、图片或文件，已忽略。'), countsOf(batch));
    }
    if (batch.items.length >= CONTINUOUS_INPUT_MESSAGE_LIMIT) {
      return result('full', t(`连续消息已收集满 {limit} 条，这条消息未收录。
请发送 go 提交，或发送 cancel 取消。`, { limit: CONTINUOUS_INPUT_MESSAGE_LIMIT }), countsOf(batch));
    }
    if (batch.imageCount + imageCount > CONTINUOUS_INPUT_IMAGE_LIMIT) {
      return result('image-full', t(`这条消息未收录：连续消息最多可收集 {limit} 张图片，当前已收集 {count} 张。
请发送 go 提交，或发送 cancel 取消后重新开始。`, {
        limit: CONTINUOUS_INPUT_IMAGE_LIMIT,
        count: batch.imageCount,
      }), countsOf(batch));
    }
    if (batch.fileCount + fileCount > CONTINUOUS_INPUT_FILE_LIMIT) {
      return result('file-full', t(`这条消息未收录：连续消息最多可收集 {limit} 个文件，当前已收集 {count} 个。
请发送 go 提交，或发送 cancel 取消后重新开始。`, {
        limit: CONTINUOUS_INPUT_FILE_LIMIT,
        count: batch.fileCount,
      }), countsOf(batch));
    }

    const content = typeof buildContent === 'function' ? buildContent() : null;
    batch.items.push({
      text: typeof text === 'string' ? text : '',
      imageCount,
      fileCount,
      content,
    });
    batch.imageCount += imageCount;
    batch.fileCount += fileCount;
    return result('collected', null, countsOf(batch));
  }

  #submit(key, batch) {
    if (batch.items.length === 0) {
      return result('empty', continuousInputEmptyMessage(), countsOf(batch));
    }
    const items = Object.freeze(batch.items.map((item) => Object.freeze({ ...item })));
    const token = Object.freeze({});
    batch.phase = 'submitting';
    batch.token = token;
    const images = [];
    const files = [];
    for (const item of items) {
      const content = item.content;
      if (!content) continue;
      if (Array.isArray(content.images)) images.push(...content.images);
      if (Array.isArray(content.files)) files.push(...content.files);
    }
    return result('submit', null, {
      token,
      items,
      prompt: continuousInputPrompt(items),
      title: submissionTitle(items),
      preparedMessage: { content: continuousInputPrompt(items), images, files },
      ...countsOf(batch),
    });
  }

  complete(key, token) {
    const batch = this.#batches.get(key);
    if (!batch || batch.phase !== 'submitting' || batch.token !== token) {
      return Object.freeze({ completed: false });
    }
    const count = batch.items.length;
    this.#batches.delete(key);
    return Object.freeze({ completed: true, count });
  }

  /**
   * Drop a batch without the submitting token. The bridge calls this from the
   * /cancel escape hatch when a submission died without calling fail() or
   * complete(), which would otherwise strand the state machine in "submitting".
   */
  forceCancel(key) {
    const batch = this.#batches.get(key);
    if (!batch) return Object.freeze({ cancelled: false, count: 0 });
    const count = batch.items.length;
    this.#batches.delete(key);
    return Object.freeze({ cancelled: true, count });
  }

  fail(key, token) {
    const batch = this.#batches.get(key);
    if (!batch || batch.phase !== 'submitting' || batch.token !== token) {
      return Object.freeze({ retained: false });
    }
    batch.phase = 'collecting';
    batch.token = null;
    const count = batch.items.length;
    return Object.freeze({
      retained: true,
      count,
      message: t(`连续消息提交失败，已保留 {count} 条消息。
请再次发送 go 重试，或发送 cancel 取消。`, { count }),
    });
  }
}
