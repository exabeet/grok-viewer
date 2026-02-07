(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const LIMIT = 40;
  const SOURCE = "MEDIA_POST_SOURCE_LIKED";
  const BUTTON_ID = "grok-viewer-open";
  const VIDEO_EXTENSIONS = [".mp4"];
  const DELETE_ENDPOINT = "/rest/media/post/delete";

  let fetchInFlight = false;
  let deleteInFlight = false;
  let lastUserKey = "";

  const getCookie = (name) => {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length < 2) return "";
    return parts.pop().split(";").shift() || "";
  };

  const getUserKey = () => {
    return getCookie("x-userid") || getCookie("x-anonuserid") || "";
  };

  const ensureUserScope = () =>
    new Promise((resolve) => {
      const currentKey = getUserKey();
      if (!currentKey || currentKey === lastUserKey) {
        resolve(false);
        return;
      }
      chrome.storage.local.get("grokViewerUserId", (data) => {
        const stored = data && data.grokViewerUserId ? data.grokViewerUserId : "";
        if (stored && stored !== currentKey) {
          chrome.storage.local.set(
            {
              grokViewerUserId: currentKey,
              [STORAGE_KEY]: { items: [], updatedAt: Date.now() }
            },
            () => {
              lastUserKey = currentKey;
              resolve(true);
            }
          );
          return;
        }
        chrome.storage.local.set({ grokViewerUserId: currentKey }, () => {
          lastUserKey = currentKey;
          resolve(false);
        });
      });
    });

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
    try {
      return new URL(url, window.location.href).toString();
    } catch (error) {
      return "";
    }
  };

  const isMp4 = (url, mimeType) => {
    if (mimeType === "video/mp4") return true;
    const base = (url || "").split(/[?#]/)[0].toLowerCase();
    return VIDEO_EXTENSIONS.some((ext) => base.endsWith(ext));
  };

  const buildVideoItem = (video, parentPostId) => {
    if (!video) return null;
    const rawUrl = video.mediaUrl || "";
    const url = normalizeUrl(rawUrl);
    const poster = normalizeUrl(video.thumbnailImageUrl || "");
    const videoId = video.id || "";
    if (!url || !isMp4(url, video.mimeType)) return null;
    return {
      id: videoId || url,
      url,
      hdMediaUrl: normalizeUrl(video.hdMediaUrl || ""),
      poster,
      postId: videoId,
      videoId,
      parentPostId: parentPostId || video.originalPostId || "",
      postUrl: `https://grok.com/imagine/post/${videoId || video.id || ''}`,
      createdAt: video.createTime || video.createdAt || "",
      source: "favorites"
    };
  };

  const extractFromPosts = (posts) => {
    const items = [];
    (posts || []).forEach((post) => {
      (post.videos || []).forEach((video) => {
        if (video.mediaType !== "MEDIA_POST_TYPE_VIDEO") return;
        const item = buildVideoItem(video, post.id);
        if (item) items.push(item);
      });
    });
    return items;
  };

  const mergeVideos = (existing, incoming) => {
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

    const map = new Map();
    (existing || []).forEach((item) => {
      if (!item || !item.postId) return;
      map.set(item.postId, item);
    });
    (incoming || []).forEach((item) => {
      if (!item || !item.postId) return;
      const prev = map.get(item.postId);
      map.set(item.postId, mergeItem(prev, item));
    });
    return Array.from(map.values());
  };

  const sortVideos = (items) => {
    return (items || [])
      .filter((item) => item && item.postId)
      .slice()
      .sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });
  };

  const persistVideos = (incoming) => {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const existing = (data && data[STORAGE_KEY] && data[STORAGE_KEY].items) || [];
      const merged = mergeVideos(existing, incoming);
      const sorted = sortVideos(merged);
      chrome.storage.local.set(
        {
          [STORAGE_KEY]: {
            items: sorted,
            updatedAt: Date.now()
          }
        },
        () => {
          chrome.runtime.sendMessage({
            action: "grokViewerVideosUpdated",
            count: sorted.length
          });
        }
      );
    });
  };

  const overwriteVideos = (incoming) => {
    const sorted = sortVideos(incoming || []);
    chrome.storage.local.set(
      {
        [STORAGE_KEY]: {
          items: sorted,
          updatedAt: Date.now()
        }
      },
      () => {
        chrome.runtime.sendMessage({
          action: "grokViewerVideosUpdated",
          count: sorted.length
        });
      }
    );
  };

  const fetchPage = async (cursor) => {
    const body = {
      limit: LIMIT,
      filter: {
        source: SOURCE
      }
    };
    if (cursor) body.cursor = cursor;

    const response = await fetch("/rest/media/post/list", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      credentials: "include",
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  };

  const fetchAllFavorites = async () => {
    if (fetchInFlight) return;
    fetchInFlight = true;
    try {
      await ensureUserScope();
      let succeeded = false;
      let cursor = undefined;
      let allItems = [];
      const seen = new Set();
      let safety = 0;
      while (true) {
        const data = await fetchPage(cursor);
        succeeded = true;
        const posts = data && data.posts ? data.posts : [];
        const items = extractFromPosts(posts);
        allItems = allItems.concat(items);
        const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
        if (!nextCursor) break;
        if (seen.has(nextCursor)) break;
        seen.add(nextCursor);
        cursor = nextCursor;
        safety += 1;
        if (safety > 200) break;
      }
      if (succeeded) {
        persistVideos(allItems);
      }
    } catch (error) {
      // ignore fetch errors
    } finally {
      fetchInFlight = false;
    }
  };

  const fullSyncFavorites = async () => {
    if (fetchInFlight) return;
    fetchInFlight = true;
    try {
      await ensureUserScope();
      let cursor = undefined;
      let allItems = [];
      const seen = new Set();
      let safety = 0;
      while (true) {
        const data = await fetchPage(cursor);
        const posts = data && data.posts ? data.posts : [];
        const items = extractFromPosts(posts);
        allItems = allItems.concat(items);
        const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
        if (!nextCursor) break;
        if (seen.has(nextCursor)) break;
        seen.add(nextCursor);
        cursor = nextCursor;
        safety += 1;
        if (safety > 200) break;
      }
      overwriteVideos(allItems);
    } catch (error) {
      // ignore fetch errors
    } finally {
      fetchInFlight = false;
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const deletePost = async (postId) => {
    if (!postId) return { ok: false, status: 0 };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(DELETE_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          credentials: "include",
          body: JSON.stringify({ id: postId })
        });
        if (response.status === 429) {
          await sleep(600 * (attempt + 1));
          continue;
        }
        return { ok: response.ok, status: response.status };
      } catch (error) {
        await sleep(400);
      }
    }
    return { ok: false, status: 429 };
  };

  const deletePostsSequential = async (postIds) => {
    const unique = Array.from(new Set((postIds || []).filter(Boolean)));
    const deleted = [];
    const failed = [];
    for (let i = 0; i < unique.length; i += 1) {
      const postId = unique[i];
      const result = await deletePost(postId);
      if (result && result.ok) {
        deleted.push(postId);
      } else {
        failed.push(postId);
      }
      await sleep(180);
    }
    return { deleted, failed };
  };

  const createFloatingButton = () => {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.title = "Open grok-viewer";
    button.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      z-index: 99999;
      padding: 0;
    `;

    const img = document.createElement("img");
    img.src = chrome.runtime.getURL("images/logo.svg");
    img.alt = "grok-viewer";
    img.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: scale-down;
      padding: 6px;
    `;

    button.appendChild(img);

    button.addEventListener("mouseenter", () => {
      button.style.transform = "scale(1.08)";
      button.style.borderColor = "rgba(255, 255, 255, 0.4)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.transform = "scale(1)";
      button.style.borderColor = "rgba(255, 255, 255, 0.2)";
    });

    button.addEventListener("click", () => {
      try {
        if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "openViewerWindow" }, () => {});
        }
      } catch (error) {
        // ignore messaging failures
      }
    });

    document.body.appendChild(button);
  };

  const ensureFloatingButton = () => {
    if (!document.body) return;
    if (!document.getElementById(BUTTON_ID)) {
      createFloatingButton();
    }
  };

  const observeButton = () => {
    const observer = new MutationObserver(() => {
      ensureFloatingButton();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === "grokViewerRefresh") {
      fetchAllFavorites().finally(() => {
        sendResponse({ ok: true });
      });
      return true;
    }
    if (message && message.action === "grokViewerDeleteOne") {
      if (deleteInFlight) {
        sendResponse({ ok: false, reason: "busy" });
        return true;
      }
      deleteInFlight = true;
      deletePost(message.postId)
        .then((result) => {
          if (result && result.ok) {
            return fetchAllFavorites().then(() => result);
          }
          return result;
        })
        .then((result) => {
          sendResponse({
            ok: Boolean(result && result.ok),
            status: result && result.status
          });
        })
        .finally(() => {
          deleteInFlight = false;
        });
      return true;
    }
    if (message && message.action === "grokViewerDeleteAll") {
      if (deleteInFlight) {
        sendResponse({ ok: false, reason: "busy" });
        return true;
      }
      deleteInFlight = true;
      const postIds = Array.isArray(message.postIds) ? message.postIds : [];
      deletePostsSequential(postIds)
        .then((result) => fetchAllFavorites().then(() => result))
        .then((result) => {
          sendResponse({
            ok: true,
            deleted: result.deleted,
            failed: result.failed
          });
        })
        .finally(() => {
          deleteInFlight = false;
        });
      return true;
    }
    if (message && message.action === "grokViewerFullSync") {
      chrome.storage.local.set({ [STORAGE_KEY]: { items: [], updatedAt: Date.now() } }, () => {
        fullSyncFavorites().finally(() => {
          sendResponse({ ok: true });
        });
      });
      return true;
    }
    return false;
  });

  const init = async () => {
    createFloatingButton();
    observeButton();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
