(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const SOURCE = "live";

  const normalizeUrl = (url) => {
    if (!url || typeof url !== "string") return "";
    if (url.startsWith("http")) return url;
    if (url.startsWith("users/") || url.startsWith("/users/")) {
      const trimmed = url.replace(/^\//, "");
      return `https://assets.grok.com/${trimmed}`;
    }
    if (url.startsWith("/imagine-public/")) {
      return `https://imagine-public.x.ai${url}`;
    }
    if (url.startsWith("imagine-public/")) {
      return `https://imagine-public.x.ai/${url}`;
    }
    return url;
  };

  const isMp4 = (url) => {
    if (!url) return false;
    const base = url.split(/[?#]/)[0].toLowerCase();
    return base.endsWith(".mp4");
  };

  const extractPostIdFromUrl = (url) => {
    if (!url) return "";
    const match = url.match(/\/generated\/([0-9a-f-]{36})\/generated_video\.mp4/i);
    return match ? match[1] : "";
  };

  const toTime = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const mergeItem = (prev, next) => {
    if (!prev) return next;
    if (!next) return prev;
    const merged = { ...prev, ...next };
    if (!next.url && prev.url) merged.url = prev.url;
    if (!next.hdMediaUrl && prev.hdMediaUrl) merged.hdMediaUrl = prev.hdMediaUrl;
    if (!next.poster && prev.poster) merged.poster = prev.poster;
    if (!next.createdAt && prev.createdAt) merged.createdAt = prev.createdAt;
    if (toTime(next.createdAt) < toTime(prev.createdAt)) merged.createdAt = prev.createdAt;
    return merged;
  };

  const addLiveVideo = (url) => {
    const full = normalizeUrl(url);
    if (!isMp4(full)) return;
    const postId = extractPostIdFromUrl(full);
    if (!postId) return;
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const existing = (data && data[STORAGE_KEY] && data[STORAGE_KEY].items) || [];
      const map = new Map();
      existing.forEach((item) => {
        if (!item || !item.postId) return;
        map.set(item.postId, item);
      });
      const next = {
        id: postId,
        postId,
        url: full,
        hdMediaUrl: "",
        poster: "",
        createdAt: new Date().toISOString(),
        source: SOURCE
      };
      const current = map.get(postId);
      map.set(postId, mergeItem(current, next));
      const merged = Array.from(map.values());
      chrome.storage.local.set(
        {
          [STORAGE_KEY]: {
            items: merged,
            updatedAt: Date.now()
          }
        },
        () => {
          chrome.runtime.sendMessage({
            action: "grokViewerVideosUpdated",
            count: merged.length
          });
        }
      );
    });
  };

  const onMessage = (event) => {
    if (!event || !event.data || event.data.source !== "grok-viewer") return;
    if (event.data.type === "videoUrl") {
      addLiveVideo(event.data.url);
      chrome.runtime.sendMessage({
        action: "grokViewerRegenPageEvent",
        eventType: "videoUrl",
        data: {
          url: event.data.url || "",
          pageUrl: event.data.pageUrl || window.location.href
        }
      });
      return;
    }
    if (event.data.type === "regenHttp" || event.data.type === "regenQuery" || event.data.type === "regenStream") {
      const data = {
        pageUrl: event.data.pageUrl || window.location.href
      };
      if (event.data.status !== undefined) data.status = event.data.status;
      if (event.data.challengeDetected === true) data.challengeDetected = true;
      if (event.data.errorHint) data.errorHint = String(event.data.errorHint);
      if (event.data.queryType) data.queryType = String(event.data.queryType);
      if (event.data.progress !== undefined && event.data.progress !== null) data.progress = Number(event.data.progress);
      if (event.data.moderated === true) data.moderated = true;
      if (event.data.videoPostId) data.videoPostId = String(event.data.videoPostId);
      if (event.data.videoUrl) data.videoUrl = String(event.data.videoUrl);
      if (event.data.thumbnailImageUrl) data.thumbnailImageUrl = String(event.data.thumbnailImageUrl);
      if (event.data.parentPostId) data.parentPostId = String(event.data.parentPostId);
      chrome.runtime.sendMessage({
        action: "grokViewerRegenPageEvent",
        eventType: event.data.type,
        data
      });
    }
  };

  window.addEventListener("message", onMessage);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const collectRoots = () => {
    const roots = [document];
    const seen = new Set([document]);
    const queue = [document.documentElement];
    while (queue.length) {
      const current = queue.shift();
      if (!current || !(current instanceof Element)) continue;
      if (current.shadowRoot && !seen.has(current.shadowRoot)) {
        seen.add(current.shadowRoot);
        roots.push(current.shadowRoot);
        const nested = current.shadowRoot.querySelectorAll("*");
        for (let i = 0; i < nested.length; i += 1) queue.push(nested[i]);
      }
      const children = current.children || [];
      for (let i = 0; i < children.length; i += 1) queue.push(children[i]);
    }
    return roots;
  };

  const queryAllDeep = (selector) => {
    const roots = collectRoots();
    const out = [];
    const seen = new Set();
    for (let i = 0; i < roots.length; i += 1) {
      let nodes = [];
      try {
        nodes = Array.from(roots[i].querySelectorAll(selector));
      } catch (error) {
        nodes = [];
      }
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j];
        if (!node || seen.has(node)) continue;
        seen.add(node);
        out.push(node);
      }
    }
    return out;
  };

  const isVisible = (node) => {
    if (!node || !(node instanceof Element)) return false;
    const style = window.getComputedStyle(node);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) === 0) return false;
    const rect = node.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  };

  const dataUrlToBlob = async (dataUrl) => {
    const response = await fetch(dataUrl);
    return response.blob();
  };

  const setPromptValue = (promptText) => {
    const promptSelectors = [
      'textarea[data-testid*="prompt" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea',
      '[contenteditable="true"][role="textbox"]'
    ];
    let promptEl = null;
    for (let i = 0; i < promptSelectors.length; i += 1) {
      const candidate = queryAllDeep(promptSelectors[i]).find((node) => isVisible(node) && !node.disabled);
      if (candidate) {
        promptEl = candidate;
        break;
      }
    }
    if (!promptEl) return false;
    const nextValue = String(promptText || "");
    if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
      promptEl.focus();
      promptEl.value = nextValue;
      promptEl.dispatchEvent(new Event("input", { bubbles: true }));
      promptEl.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    promptEl.focus();
    promptEl.textContent = nextValue;
    promptEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue }));
    return true;
  };

  const clickGenerateButton = () => {
    const labels = [/^generate$/i, /^create$/i, /generate video/i, /create video/i];
    const buttons = queryAllDeep('button,[role="button"]');
    const candidate = buttons.find((button) => {
      if (!isVisible(button)) return false;
      if (button.disabled || String(button.getAttribute("aria-disabled") || "").toLowerCase() === "true") return false;
      const text = String(button.textContent || "").trim();
      return labels.some((rx) => rx.test(text));
    });
    if (!candidate) return false;
    candidate.click();
    return true;
  };

  const uploadSeedImage = async (payload) => {
    const input = queryAllDeep('input[type="file"]').find((node) => {
      if (!(node instanceof HTMLInputElement)) return false;
      const accepts = String(node.accept || "").toLowerCase();
      return accepts.includes("image") || accepts === "";
    });
    if (!input) {
      throw new Error("image-upload-input-not-found");
    }
    const blob = await dataUrlToBlob(payload.imageDataUrl);
    const file = new File([blob], payload.filename || `sequence-seed-${Date.now()}.jpg`, {
      type: payload.mimeType || blob.type || "image/jpeg"
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const handleSequenceGenerate = async (payload) => {
    if (!payload || !payload.imageDataUrl) {
      return { ok: false, error: "missing-image-data" };
    }
    if (!/\/imagine(?:[/?#]|$)/i.test(window.location.pathname)) {
      return { ok: false, error: "not-imagine-page" };
    }
    await uploadSeedImage(payload);
    await sleep(220);
    setPromptValue(payload.promptText || "");
    await sleep(160);
    const clicked = clickGenerateButton();
    if (!clicked) return { ok: false, error: "generate-button-not-found" };
    return { ok: true };
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.action !== "grokViewerSequenceGenerateFromImage") return false;
    handleSequenceGenerate(message.payload)
      .then((result) => sendResponse(result || { ok: false, error: "sequence-empty-result" }))
      .catch((error) => {
        sendResponse({ ok: false, error: String((error && error.message) || error || "sequence-failed") });
      });
    return true;
  });

  const injectScript = () => {
    if (document.getElementById("grok-viewer-hook")) return;
    const script = document.createElement("script");
    script.id = "grok-viewer-hook";
    script.src = chrome.runtime.getURL("page-hook.js");
    script.onload = () => {
      script.remove();
    };
    document.documentElement.appendChild(script);
  };

  injectScript();
})();
