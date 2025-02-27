const crypto = require('crypto');
const TextStream = require('./TextStream');
const { getConvo, getMessages, saveMessage, updateMessage, saveConvo } = require('~/models');
const { addSpaceIfNeeded, isEnabled } = require('~/server/utils');
const checkBalance = require('~/models/checkBalance');

class BaseClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.sender = options.sender ?? 'AI';
    this.contextStrategy = null;
    this.currentDateString = new Date().toLocaleDateString('en-us', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  setOptions() {
    throw new Error('Method \'setOptions\' must be implemented.');
  }

  getCompletion() {
    throw new Error('Method \'getCompletion\' must be implemented.');
  }

  async sendCompletion() {
    throw new Error('Method \'sendCompletion\' must be implemented.');
  }

  getSaveOptions() {
    throw new Error('Subclasses must implement getSaveOptions');
  }

  async buildMessages() {
    throw new Error('Subclasses must implement buildMessages');
  }

  async summarizeMessages() {
    throw new Error('Subclasses attempted to call summarizeMessages without implementing it');
  }

  async getTokenCountForResponse(response) {
    if (this.options.debug) {
      console.debug('`recordTokenUsage` not implemented.', response);
    }
  }

  async recordTokenUsage({ promptTokens, completionTokens }) {
    if (this.options.debug) {
      console.debug('`recordTokenUsage` not implemented.', { promptTokens, completionTokens });
    }
  }

  getBuildMessagesOptions() {
    throw new Error('Subclasses must implement getBuildMessagesOptions');
  }

  async generateTextStream(text, onProgress, options = {}) {
    const stream = new TextStream(text, options);
    await stream.processTextStream(onProgress);
  }

  async setMessageOptions(opts = {}) {
    if (opts && opts.replaceOptions) {
      this.setOptions(opts);
    }

    const { isEdited, isContinued } = opts;
    const user = opts.user ?? null;
    this.user = user;
    const saveOptions = this.getSaveOptions();
    this.abortController = opts.abortController ?? new AbortController();
    const conversationId = opts.conversationId ?? crypto.randomUUID();
    const parentMessageId = opts.parentMessageId ?? '00000000-0000-0000-0000-000000000000';
    const userMessageId = opts.overrideParentMessageId ?? crypto.randomUUID();
    let responseMessageId = opts.responseMessageId ?? crypto.randomUUID();
    let head = isEdited ? responseMessageId : parentMessageId;
    this.currentMessages = (await this.loadHistory(conversationId, head)) ?? [];
    this.conversationId = conversationId;

    if (isEdited && !isContinued) {
      responseMessageId = crypto.randomUUID();
      head = responseMessageId;
      this.currentMessages[this.currentMessages.length - 1].messageId = head;
    }

    return {
      ...opts,
      user,
      head,
      conversationId,
      parentMessageId,
      userMessageId,
      responseMessageId,
      saveOptions,
    };
  }

  createUserMessage({ messageId, parentMessageId, conversationId, text }) {
    return {
      messageId,
      parentMessageId,
      conversationId,
      sender: 'User',
      text,
      isCreatedByUser: true,
    };
  }

  async handleStartMethods(message, opts) {
    const {
      user,
      head,
      conversationId,
      parentMessageId,
      userMessageId,
      responseMessageId,
      saveOptions,
    } = await this.setMessageOptions(opts);

    const userMessage = opts.isEdited
      ? this.currentMessages[this.currentMessages.length - 2]
      : this.createUserMessage({
        messageId: userMessageId,
        parentMessageId,
        conversationId,
        text: message,
      });

    if (typeof opts?.getReqData === 'function') {
      opts.getReqData({
        userMessage,
        conversationId,
        responseMessageId,
      });
    }

    if (typeof opts?.onStart === 'function') {
      opts.onStart(userMessage);
    }

    return {
      ...opts,
      user,
      head,
      conversationId,
      responseMessageId,
      saveOptions,
      userMessage,
    };
  }

  /**
   * Adds instructions to the messages array. If the instructions object is empty or undefined,
   * the original messages array is returned. Otherwise, the instructions are added to the messages
   * array, preserving the last message at the end.
   *
   * @param {Array} messages - An array of messages.
   * @param {Object} instructions - An object containing instructions to be added to the messages.
   * @returns {Array} An array containing messages and instructions, or the original messages if instructions are empty.
   */
  addInstructions(messages, instructions) {
    const payload = [];
    if (!instructions || Object.keys(instructions).length === 0) {
      return messages;
    }
    if (messages.length > 1) {
      payload.push(...messages.slice(0, -1));
    }

    payload.push(instructions);

    if (messages.length > 0) {
      payload.push(messages[messages.length - 1]);
    }

    return payload;
  }

  async handleTokenCountMap(tokenCountMap) {
    if (this.currentMessages.length === 0) {
      return;
    }

    for (let i = 0; i < this.currentMessages.length; i++) {
      // Skip the last message, which is the user message.
      if (i === this.currentMessages.length - 1) {
        break;
      }

      const message = this.currentMessages[i];
      const { messageId } = message;
      const update = {};

      if (messageId === tokenCountMap.summaryMessage?.messageId) {
        this.options.debug && console.debug(`Adding summary props to ${messageId}.`);

        update.summary = tokenCountMap.summaryMessage.content;
        update.summaryTokenCount = tokenCountMap.summaryMessage.tokenCount;
      }

      if (message.tokenCount && !update.summaryTokenCount) {
        this.options.debug && console.debug(`Skipping ${messageId}: already had a token count.`);
        continue;
      }

      const tokenCount = tokenCountMap[messageId];
      if (tokenCount) {
        message.tokenCount = tokenCount;
        update.tokenCount = tokenCount;
        await this.updateMessageInDatabase({ messageId, ...update });
      }
    }
  }

  concatenateMessages(messages) {
    return messages.reduce((acc, message) => {
      const nameOrRole = message.name ?? message.role;
      return acc + `${nameOrRole}:\n${message.content}\n\n`;
    }, '');
  }

  /**
   * This method processes an array of messages and returns a context of messages that fit within a specified token limit.
   * It iterates over the messages from newest to oldest, adding them to the context until the token limit is reached.
   * If the token limit would be exceeded by adding a message, that message is not added to the context and remains in the original array.
   * The method uses `push` and `pop` operations for efficient array manipulation, and reverses the context array at the end to maintain the original order of the messages.
   *
   * @param {Array} _messages - An array of messages, each with a `tokenCount` property. The messages should be ordered from oldest to newest.
   * @param {number} [maxContextTokens] - The max number of tokens allowed in the context. If not provided, defaults to `this.maxContextTokens`.
   * @returns {Object} An object with four properties: `context`, `summaryIndex`, `remainingContextTokens`, and `messagesToRefine`.
   *    `context` is an array of messages that fit within the token limit.
   *    `summaryIndex` is the index of the first message in the `messagesToRefine` array.
   *    `remainingContextTokens` is the number of tokens remaining within the limit after adding the messages to the context.
   *    `messagesToRefine` is an array of messages that were not added to the context because they would have exceeded the token limit.
   */
  async getMessagesWithinTokenLimit(_messages, maxContextTokens) {
    // Every reply is primed with <|start|>assistant<|message|>, so we
    // start with 3 tokens for the label after all messages have been counted.
    let currentTokenCount = 3;
    let summaryIndex = -1;
    let remainingContextTokens = maxContextTokens ?? this.maxContextTokens;
    const messages = [..._messages];

    const context = [];
    if (currentTokenCount < remainingContextTokens) {
      while (messages.length > 0 && currentTokenCount < remainingContextTokens) {
        const poppedMessage = messages.pop();
        const { tokenCount } = poppedMessage;

        if (poppedMessage && currentTokenCount + tokenCount <= remainingContextTokens) {
          context.push(poppedMessage);
          currentTokenCount += tokenCount;
        } else {
          messages.push(poppedMessage);
          break;
        }
      }
    }

    const prunedMemory = messages;
    summaryIndex = prunedMemory.length - 1;
    remainingContextTokens -= currentTokenCount;

    return {
      context: context.reverse(),
      remainingContextTokens,
      messagesToRefine: prunedMemory,
      summaryIndex,
    };
  }

  async handleContextStrategy({ instructions, orderedMessages, formattedMessages }) {
    let _instructions;
    let tokenCount;

    if (instructions) {
      ({ tokenCount, ..._instructions } = instructions);
    }
    this.options.debug && _instructions && console.debug('instructions tokenCount', tokenCount);
    let payload = this.addInstructions(formattedMessages, _instructions);
    let orderedWithInstructions = this.addInstructions(orderedMessages, instructions);

    let { context, remainingContextTokens, messagesToRefine, summaryIndex } =
      await this.getMessagesWithinTokenLimit(orderedWithInstructions);

    this.options.debug &&
      console.debug(
        'remainingContextTokens, this.maxContextTokens (1/2)',
        remainingContextTokens,
        this.maxContextTokens,
      );

    let summaryMessage;
    let summaryTokenCount;
    let { shouldSummarize } = this;

    // Calculate the difference in length to determine how many messages were discarded if any
    const { length } = payload;
    const diff = length - context.length;
    const firstMessage = orderedWithInstructions[0];
    const usePrevSummary =
      shouldSummarize &&
      diff === 1 &&
      firstMessage?.summary &&
      this.previous_summary.messageId === firstMessage.messageId;

    if (diff > 0) {
      payload = payload.slice(diff);
      this.options.debug &&
        console.debug(
          `Difference between original payload (${length}) and context (${context.length}): ${diff}`,
        );
    }

    const latestMessage = orderedWithInstructions[orderedWithInstructions.length - 1];
    if (payload.length === 0 && !shouldSummarize && latestMessage) {
      throw new Error(
        `Prompt token count of ${latestMessage.tokenCount} exceeds max token count of ${this.maxContextTokens}.`,
      );
    }

    if (usePrevSummary) {
      summaryMessage = { role: 'system', content: firstMessage.summary };
      summaryTokenCount = firstMessage.summaryTokenCount;
      payload.unshift(summaryMessage);
      remainingContextTokens -= summaryTokenCount;
    } else if (shouldSummarize && messagesToRefine.length > 0) {
      ({ summaryMessage, summaryTokenCount } = await this.summarizeMessages({
        messagesToRefine,
        remainingContextTokens,
      }));
      summaryMessage && payload.unshift(summaryMessage);
      remainingContextTokens -= summaryTokenCount;
    }

    // Make sure to only continue summarization logic if the summary message was generated
    shouldSummarize = summaryMessage && shouldSummarize;

    this.options.debug &&
      console.debug(
        'remainingContextTokens, this.maxContextTokens (2/2)',
        remainingContextTokens,
        this.maxContextTokens,
      );

    let tokenCountMap = orderedWithInstructions.reduce((map, message, index) => {
      const { messageId } = message;
      if (!messageId) {
        return map;
      }

      if (shouldSummarize && index === summaryIndex && !usePrevSummary) {
        map.summaryMessage = { ...summaryMessage, messageId, tokenCount: summaryTokenCount };
      }

      map[messageId] = orderedWithInstructions[index].tokenCount;
      return map;
    }, {});

    const promptTokens = this.maxContextTokens - remainingContextTokens;

    if (this.options.debug) {
      console.debug('<-------------------------PAYLOAD/TOKEN COUNT MAP------------------------->');
      console.debug('Payload:', payload);
      console.debug('Token Count Map:', tokenCountMap);
      console.debug(
        'Prompt Tokens',
        promptTokens,
        'remainingContextTokens',
        remainingContextTokens,
        'this.maxContextTokens',
        this.maxContextTokens,
      );
    }

    return { payload, tokenCountMap, promptTokens, messages: orderedWithInstructions };
  }

  async sendMessage(message, opts = {}) {
    const { user, head, isEdited, conversationId, responseMessageId, saveOptions, userMessage } =
      await this.handleStartMethods(message, opts);

    const { generation = '' } = opts;

    // It's not necessary to push to currentMessages
    // depending on subclass implementation of handling messages
    // When this is an edit, all messages are already in currentMessages, both user and response
    if (isEdited) {
      let latestMessage = this.currentMessages[this.currentMessages.length - 1];
      if (!latestMessage) {
        latestMessage = {
          messageId: responseMessageId,
          conversationId,
          parentMessageId: userMessage.messageId,
          isCreatedByUser: false,
          model: this.modelOptions.model,
          sender: this.sender,
          text: generation,
        };
        this.currentMessages.push(userMessage, latestMessage);
      } else {
        latestMessage.text = generation;
      }
    } else {
      this.currentMessages.push(userMessage);
    }

    let {
      prompt: payload,
      tokenCountMap,
      promptTokens,
    } = await this.buildMessages(
      this.currentMessages,
      // When the userMessage is pushed to currentMessages, the parentMessage is the userMessageId.
      // this only matters when buildMessages is utilizing the parentMessageId, and may vary on implementation
      isEdited ? head : userMessage.messageId,
      this.getBuildMessagesOptions(opts),
      opts,
    );

    if (tokenCountMap) {
      console.dir(tokenCountMap, { depth: null });
      if (tokenCountMap[userMessage.messageId]) {
        userMessage.tokenCount = tokenCountMap[userMessage.messageId];
        console.log('userMessage.tokenCount', userMessage.tokenCount);
        console.log('userMessage', userMessage);
      }

      this.handleTokenCountMap(tokenCountMap);
    }

    if (!isEdited) {
      await this.saveMessageToDatabase(userMessage, saveOptions, user);
    }

    if (isEnabled(process.env.CHECK_BALANCE)) {
      await checkBalance({
        req: this.options.req,
        res: this.options.res,
        txData: {
          user: this.user,
          tokenType: 'prompt',
          amount: promptTokens,
          debug: this.options.debug,
          model: this.modelOptions.model,
          endpoint: this.options.endpoint,
        },
      });
    }

    const completion = await this.sendCompletion(payload, opts);
    const responseMessage = {
      messageId: responseMessageId,
      conversationId,
      parentMessageId: userMessage.messageId,
      isCreatedByUser: false,
      isEdited,
      model: this.modelOptions.model,
      sender: this.sender,
      text: addSpaceIfNeeded(generation) + completion,
      promptTokens,
    };

    if (
      tokenCountMap &&
      this.recordTokenUsage &&
      this.getTokenCountForResponse &&
      this.getTokenCount
    ) {
      responseMessage.tokenCount = this.getTokenCountForResponse(responseMessage);
      const completionTokens = this.getTokenCount(completion);
      await this.recordTokenUsage({ promptTokens, completionTokens });
    }
    await this.saveMessageToDatabase(responseMessage, saveOptions, user);
    delete responseMessage.tokenCount;
    return responseMessage;
  }

  async getConversation(conversationId, user = null) {
    return await getConvo(user, conversationId);
  }

  async loadHistory(conversationId, parentMessageId = null) {
    if (this.options.debug) {
      console.debug('Loading history for conversation', conversationId, parentMessageId);
    }

    const messages = (await getMessages({ conversationId })) ?? [];

    if (messages.length === 0) {
      return [];
    }

    let mapMethod = null;
    if (this.getMessageMapMethod) {
      mapMethod = this.getMessageMapMethod();
    }

    const orderedMessages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      mapMethod,
    });

    if (!this.shouldSummarize) {
      return orderedMessages;
    }

    // Find the latest message with a 'summary' property
    for (let i = orderedMessages.length - 1; i >= 0; i--) {
      if (orderedMessages[i]?.summary) {
        this.previous_summary = orderedMessages[i];
        break;
      }
    }

    if (this.options.debug && this.previous_summary) {
      const { messageId, summary, tokenCount, summaryTokenCount } = this.previous_summary;
      console.debug('Previous summary:', { messageId, summary, tokenCount, summaryTokenCount });
    }

    return orderedMessages;
  }

  async saveMessageToDatabase(message, endpointOptions, user = null) {
    await saveMessage({ ...message, user, unfinished: false, cancelled: false });
    await saveConvo(user, {
      conversationId: message.conversationId,
      endpoint: this.options.endpoint,
      ...endpointOptions,
    });
  }

  async updateMessageInDatabase(message) {
    await updateMessage(message);
  }

  /**
   * Iterate through messages, building an array based on the parentMessageId.
   *
   * This function constructs a conversation thread by traversing messages from a given parentMessageId up to the root message.
   * It handles cyclic references by ensuring that a message is not processed more than once.
   * If the 'summary' option is set to true and a message has a 'summary' property:
   * - The message's 'role' is set to 'system'.
   * - The message's 'text' is set to its 'summary'.
   * - If the message has a 'summaryTokenCount', the message's 'tokenCount' is set to 'summaryTokenCount'.
   * The traversal stops at the message with the 'summary' property.
   *
   * Each message object should have an 'id' or 'messageId' property and may have a 'parentMessageId' property.
   * The 'parentMessageId' is the ID of the message that the current message is a reply to.
   * If 'parentMessageId' is not present, null, or is '00000000-0000-0000-0000-000000000000',
   * the message is considered a root message.
   *
   * @param {Object} options - The options for the function.
   * @param {Array} options.messages - An array of message objects. Each object should have either an 'id' or 'messageId' property, and may have a 'parentMessageId' property.
   * @param {string} options.parentMessageId - The ID of the parent message to start the traversal from.
   * @param {Function} [options.mapMethod] - An optional function to map over the ordered messages. If provided, it will be applied to each message in the resulting array.
   * @param {boolean} [options.summary=false] - If set to true, the traversal modifies messages with 'summary' and 'summaryTokenCount' properties and stops at the message with a 'summary' property.
   * @returns {Array} An array containing the messages in the order they should be displayed, starting with the most recent message with a 'summary' property if the 'summary' option is true, and ending with the message identified by 'parentMessageId'.
   */
  static getMessagesForConversation({
    messages,
    parentMessageId,
    mapMethod = null,
    summary = false,
  }) {
    if (!messages || messages.length === 0) {
      return [];
    }

    const orderedMessages = [];
    let currentMessageId = parentMessageId;
    const visitedMessageIds = new Set();

    while (currentMessageId) {
      if (visitedMessageIds.has(currentMessageId)) {
        break;
      }
      const message = messages.find((msg) => {
        const messageId = msg.messageId ?? msg.id;
        return messageId === currentMessageId;
      });

      visitedMessageIds.add(currentMessageId);

      if (!message) {
        break;
      }

      if (summary && message.summary) {
        message.role = 'system';
        message.text = message.summary;
      }

      if (summary && message.summaryTokenCount) {
        message.tokenCount = message.summaryTokenCount;
      }

      orderedMessages.push(message);

      if (summary && message.summary) {
        break;
      }

      currentMessageId =
        message.parentMessageId === '00000000-0000-0000-0000-000000000000'
          ? null
          : message.parentMessageId;
    }

    orderedMessages.reverse();

    if (mapMethod) {
      return orderedMessages.map(mapMethod);
    }

    return orderedMessages;
  }

  /**
   * Algorithm adapted from "6. Counting tokens for chat API calls" of
   * https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
   *
   * An additional 3 tokens need to be added for assistant label priming after all messages have been counted.
   * In our implementation, this is accounted for in the getMessagesWithinTokenLimit method.
   *
   * @param {Object} message
   */
  getTokenCountForMessage(message) {
    // Note: gpt-3.5-turbo and gpt-4 may update over time. Use default for these as well as for unknown models
    let tokensPerMessage = 3;
    let tokensPerName = 1;

    if (this.modelOptions.model === 'gpt-3.5-turbo-0301') {
      tokensPerMessage = 4;
      tokensPerName = -1;
    }

    const processValue = (value) => {
      if (typeof value === 'object' && value !== null) {
        for (let [nestedKey, nestedValue] of Object.entries(value)) {
          if (nestedKey === 'image_url' || nestedValue === 'image_url') {
            continue;
          }
          processValue(nestedValue);
        }
      } else {
        numTokens += this.getTokenCount(value);
      }
    };

    let numTokens = tokensPerMessage;
    for (let [key, value] of Object.entries(message)) {
      processValue(value);

      if (key === 'name') {
        numTokens += tokensPerName;
      }
    }
    return numTokens;
  }

  async sendPayload(payload, opts = {}) {
    if (opts && typeof opts === 'object') {
      this.setOptions(opts);
    }

    return await this.sendCompletion(payload, opts);
  }
}

module.exports = BaseClient;
