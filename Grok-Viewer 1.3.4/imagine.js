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
    }
  };

  window.addEventListener("message", onMessage);

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
