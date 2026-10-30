(() => {
  "use strict";

  const STORAGE_KEY = "mini-brain-chats-v1";
  const MAX_CHATS = 40;
  const MAX_HISTORY = 24;
  const suggestions = [
    ["Написать текст", "Помоги составить письмо или пост"],
    ["Разобраться в теме", "Объясни сложное простыми словами"],
    ["Придумать идею", "Предложи несколько необычных вариантов"],
    ["Помочь с планом", "Разбей мою задачу на шаги"]
  ];
  const elements = {
    messages: document.querySelector("#messages"),
    list: document.querySelector("#chatList"),
    form: document.querySelector("#chatForm"),
    input: document.querySelector("#messageInput"),
    send: document.querySelector("#sendButton"),
    newChat: document.querySelector("#newChat"),
    openSidebar: document.querySelector("#openSidebar"),
    closeSidebar: document.querySelector("#closeSidebar"),
    scrim: document.querySelector("#sidebarScrim"),
    toast: document.querySelector("#toast"),
    share: document.querySelector("#shareChat")
  };
  let chats = loadChats();
  let activeId = chats[0]?.id ?? null;
  let busy = false;
  let busyChatId = null;
  let requestStartedAt = 0;
  let retryUntil = 0;
  let typingElapsed = null;
  let typingRetry = null;
  let waitingInterval = null;
  let toastTimer;

  function loadChats() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved.filter(chat => chat && typeof chat.id === "string" && Array.isArray(chat.messages))
        .map(chat => ({
          id: chat.id,
          title: typeof chat.title === "string" ? chat.title.slice(0, 80) : "Новый чат",
          updatedAt: Number(chat.updatedAt) || Date.now(),
          messages: chat.messages.filter(message =>
            message && ["user", "assistant"].includes(message.role) && typeof message.content === "string"
          ).slice(-MAX_HISTORY * 2)
        })).slice(0, MAX_CHATS);
    } catch (error) {
      console.warn("Не удалось прочитать локальную историю чатов.", error);
      return [];
    }
  }

  function saveChats() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats.slice(0, MAX_CHATS)));
    } catch (error) {
      console.warn("Не удалось сохранить локальную историю чатов.", error);
      showToast("Не удалось сохранить историю в браузере");
    }
  }

  function activeChat() {
    return chats.find(chat => chat.id === activeId) || null;
  }

  function createChat() {
    const chat = { id: crypto.randomUUID(), title: "Новый чат", updatedAt: Date.now(), messages: [] };
    chats.unshift(chat);
    chats = chats.slice(0, MAX_CHATS);
    activeId = chat.id;
    saveChats();
    render();
    closeMobileSidebar();
    elements.input.focus();
  }

  function selectChat(id) {
    activeId = id;
    render();
    closeMobileSidebar();
  }

  function deleteChat(id) {
    chats = chats.filter(chat => chat.id !== id);
    if (activeId === id) activeId = chats[0]?.id ?? null;
    saveChats();
    render();
  }

  function render() {
    renderChatList();
    renderMessages();
    elements.send.disabled = busy || !elements.input.value.trim();
  }

  function renderChatList() {
    elements.list.replaceChildren();
    if (!chats.length) {
      const empty = document.createElement("p");
      empty.className = "empty-history";
      empty.textContent = "Здесь появятся ваши разговоры.";
      elements.list.append(empty);
      return;
    }
    chats.forEach(chat => {
      const row = document.createElement("div");
      row.className = `chat-item${chat.id === activeId ? " active" : ""}`;
      const select = document.createElement("button");
      select.className = "chat-select";
      select.type = "button";
      select.textContent = chat.title || "Новый чат";
      select.title = chat.title || "Новый чат";
      select.setAttribute("aria-current", chat.id === activeId ? "page" : "false");
      select.addEventListener("click", () => selectChat(chat.id));
      const remove = document.createElement("button");
      remove.className = "chat-delete";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Удалить чат «${chat.title}»`);
      remove.addEventListener("click", () => deleteChat(chat.id));
      row.append(select, remove);
      elements.list.append(row);
    });
  }

  function renderMessages() {
    elements.messages.replaceChildren();
    typingElapsed = null;
    typingRetry = null;
    const chat = activeChat();
    if (!chat || !chat.messages.length) {
      elements.messages.append(createWelcome());
      return;
    }
    chat.messages.forEach(message => elements.messages.append(createMessage(message)));
    if (busy && chat.id === busyChatId) elements.messages.append(createTyping());
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function createWelcome() {
    const wrap = document.createElement("div");
    wrap.className = "welcome";
    const icon = document.createElement("div");
    icon.className = "welcome-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 32 32"><path d="M16 4.5c-5.8 0-10.5 4.4-10.5 9.9 0 3.2 1.7 5.9 4.3 7.7v5.4l6.2-3.1c5.8 0 10.5-4.4 10.5-9.9S21.8 4.5 16 4.5Z"/><path d="M11 14.5h.1m4.9 0h.1m4.9 0h.1M12 19c1.1 1 2.4 1.5 4 1.5s2.9-.5 4-1.5"/></svg>';
    const title = document.createElement("h1");
    title.textContent = "О чём подумаем сегодня?";
    const description = document.createElement("p");
    description.textContent = "Ваш помощник для идей, текстов и новых открытий.";
    const options = document.createElement("div");
    options.className = "suggestions";
    suggestions.forEach(([heading, caption]) => {
      const button = document.createElement("button");
      button.className = "suggestion";
      button.type = "button";
      const strong = document.createElement("strong");
      strong.textContent = heading;
      const span = document.createElement("span");
      span.textContent = caption;
      button.append(strong, span);
      button.addEventListener("click", () => {
        elements.input.value = `${heading}: ${caption}`;
        resizeInput();
        elements.send.disabled = busy ? true : false;
        elements.input.focus();
      });
      options.append(button);
    });
    wrap.append(icon, title, description, options);
    return wrap;
  }

  function createMessage(message) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    const label = document.createElement("div");
    label.className = "message-label";
    if (message.role === "user") {
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = "m";
      label.append(avatar, document.createTextNode("Вы"));
    } else {
      const mark = document.createElement("span");
      mark.className = "assistant-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.innerHTML = '<svg viewBox="0 0 20 20"><path d="M10 2.8c-3.8 0-6.8 2.8-6.8 6.4 0 2.1 1.1 3.8 2.8 5v3.5l4-2c3.8 0 6.8-2.8 6.8-6.4s-3-6.5-6.8-6.5Z"/><path d="M7 9h.1m3 0h.1m3 0h.1"/></svg>';
      label.append(mark, document.createTextNode("Mini-brain"));
    }
    const body = document.createElement("div");
    body.className = "message-body";
    if (message.role === "assistant") appendMarkdown(body, message.content);
    else body.textContent = message.content;
    article.append(label, body);
    return article;
  }

  function createTyping() {
    const article = document.createElement("article");
    article.className = "message assistant";
    article.setAttribute("aria-label", "Mini-brain печатает ответ");
    const label = document.createElement("div");
    label.className = "message-label";
    const mark = document.createElement("span");
    mark.className = "assistant-mark";
    mark.textContent = "✳";
    label.append(mark, document.createTextNode("Mini-brain"));
    const dots = document.createElement("div");
    dots.className = "typing";
    dots.setAttribute("aria-label", "Готовит ответ");
    for (let i = 0; i < 3; i++) dots.append(document.createElement("span"));
    const status = document.createElement("span");
    status.className = "typing-status";
    status.textContent = "Mini-brain печатает ответ…";
    typingElapsed = document.createElement("span");
    typingElapsed.className = "typing-elapsed";
    typingElapsed.setAttribute("aria-hidden", "true");
    typingRetry = document.createElement("span");
    typingRetry.className = "typing-retry";
    typingRetry.setAttribute("aria-hidden", "true");
    typingRetry.hidden = true;
    dots.append(status, typingElapsed, typingRetry);
    article.append(label, dots);
    return article;
  }

  function updateTypingIndicator() {
    if (typingElapsed && requestStartedAt) {
      const elapsedSeconds = Math.floor((Date.now() - requestStartedAt) / 1000);
      typingElapsed.textContent = `${elapsedSeconds} с`;
    }
    if (typingRetry && retryUntil) {
      const remainingSeconds = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
      typingRetry.textContent = `Повтор через ${remainingSeconds} с`;
      typingRetry.hidden = remainingSeconds === 0;
    }
  }

  function retryDelaySeconds(response) {
    if (response.status !== 429) return null;
    const header = response.headers.get("Retry-After");
    if (!header || !/^\d+$/.test(header)) return null;
    const seconds = Number(header);
    return seconds > 0 && seconds <= 60 ? seconds : null;
  }

  async function requestChatResponse(base, messages) {
    const send = () => fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(90000)
    });
    const response = await send();
    const delaySeconds = retryDelaySeconds(response);
    if (delaySeconds === null) return response;

    retryUntil = Date.now() + delaySeconds * 1000;
    updateTypingIndicator();
    await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    retryUntil = 0;
    updateTypingIndicator();
    return send();
  }

  function appendMarkdown(container, markdown) {
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    let list = null;
    let codeLines = null;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = document.createElement("p");
      appendInline(p, paragraph.join(" "));
      container.append(p);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      container.append(list);
      list = null;
    };
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        flushParagraph();
        flushList();
        if (codeLines) {
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = codeLines.join("\n");
          pre.append(code);
          container.append(pre);
          codeLines = null;
        } else codeLines = [];
        continue;
      }
      if (codeLines) {
        codeLines.push(line);
        continue;
      }
      const heading = line.match(/^(#{2,3})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const h = document.createElement(heading[1].length === 2 ? "h2" : "h3");
        appendInline(h, heading[2]);
        container.append(h);
        continue;
      }
      const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (item) {
        flushParagraph();
        const ordered = /^\s*\d+\./.test(line);
        if (!list || list.tagName.toLowerCase() !== (ordered ? "ol" : "ul")) {
          flushList();
          list = document.createElement(ordered ? "ol" : "ul");
        }
        const li = document.createElement("li");
        appendInline(li, item[1]);
        list.append(li);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line.trim());
      }
    }
    if (codeLines) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      container.append(pre);
    }
    flushParagraph();
    flushList();
  }

  function appendInline(parent, text) {
    const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index;
      if (index > last) parent.append(document.createTextNode(text.slice(last, index)));
      const token = match[0];
      let node;
      if (token.startsWith("**") || token.startsWith("__")) {
        node = document.createElement("strong");
        node.textContent = token.slice(2, -2);
      } else if (token.startsWith("`")) {
        node = document.createElement("code");
        node.textContent = token.slice(1, -1);
      } else {
        node = document.createElement("em");
        node.textContent = token.slice(1, -1);
      }
      parent.append(node);
      last = index + token.length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = elements.input.value.trim();
    if (!text || busy) return;
    let chat = activeChat();
    if (!chat) {
      createChat();
      chat = activeChat();
    }
    chat.messages.push({ role: "user", content: text });
    if (chat.messages.filter(message => message.role === "user").length === 1) {
      chat.title = text.replace(/\s+/g, " ").slice(0, 42) || "Новый чат";
    }
    chat.updatedAt = Date.now();
    elements.input.value = "";
    resizeInput();
    busy = true;
    busyChatId = chat.id;
    requestStartedAt = Date.now();
    saveChats();
    render();
    updateTypingIndicator();
    waitingInterval = setInterval(updateTypingIndicator, 1000);

    try {
      const base = (window.MINI_BRAIN_CONFIG?.apiBaseUrl || "").trim().replace(/\/+$/, "");
      if (!base) throw new Error("Сервер пока не подключён. Укажите адрес API в файле config.js.");
      const response = await requestChatResponse(base, chat.messages.slice(-MAX_HISTORY));
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = typeof data?.detail === "string" ? data.detail : "Сервер не смог обработать запрос.";
        throw new Error(detail);
      }
      if (typeof data?.reply !== "string" || !data.reply.trim()) {
        throw new Error("Сервер вернул пустой ответ. Попробуйте ещё раз.");
      }
      chat.messages.push({ role: "assistant", content: data.reply.trim() });
      chat.updatedAt = Date.now();
    } catch (error) {
      const text = error.name === "TimeoutError" || error.name === "AbortError"
        ? "Сервер не ответил вовремя. Запрос не повторён автоматически, чтобы избежать возможной повторной отправки."
        : error instanceof TypeError
          ? "Не удалось связаться с сервером. Запрос не повторён автоматически, так как сервер мог уже его получить."
          : error.message || "Не удалось получить ответ.";
      chat.messages.push({ role: "assistant", content: `Не получилось отправить сообщение. ${text}` });
    } finally {
      clearInterval(waitingInterval);
      waitingInterval = null;
      busy = false;
      busyChatId = null;
      requestStartedAt = 0;
      retryUntil = 0;
      saveChats();
      render();
      elements.input.focus();
    }
  }

  function resizeInput() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 190)}px`;
    elements.send.disabled = busy || !elements.input.value.trim();
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2200);
  }

  function openMobileSidebar() {
    document.querySelector("#sidebar").classList.add("open");
    elements.scrim.classList.add("visible");
  }

  function closeMobileSidebar() {
    document.querySelector("#sidebar").classList.remove("open");
    elements.scrim.classList.remove("visible");
  }

  elements.form.addEventListener("submit", sendMessage);
  elements.input.addEventListener("input", resizeInput);
  elements.input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });
  elements.newChat.addEventListener("click", createChat);
  elements.openSidebar.addEventListener("click", openMobileSidebar);
  elements.closeSidebar.addEventListener("click", closeMobileSidebar);
  elements.scrim.addEventListener("click", closeMobileSidebar);
  elements.share.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast("Адрес страницы скопирован");
    } catch (error) {
      console.warn("Не удалось скопировать адрес страницы.", error);
      showToast("Не удалось скопировать адрес страницы");
    }
  });
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      createChat();
    }
    if (event.key === "Escape") closeMobileSidebar();
  });

  render();
  elements.input.focus({ preventScroll: true });
})();
