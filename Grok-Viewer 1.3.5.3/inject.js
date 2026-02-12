(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const LIST_ENDPOINT = "/rest/media/post/list";
  const LIMIT = 40;
  const SOURCE_LIKED = "MEDIA_POST_SOURCE_LIKED";
  const SOURCE_CANDIDATES = [
    "MEDIA_POST_SOURCE_OWNED",
    "MEDIA_POST_SOURCE_CREATED",
    "MEDIA_POST_SOURCE_USER"
  ];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getCookie = (name) => {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length < 2) return "";
    return parts.pop().split(";").shift() || "";
  };

  const getUserId = () => getCookie("x-userid");

  const isMp4 = (url, mimeType) => {
    if (mimeType === "video/mp4") return true;
    const base = (url || "").split(/[?#]/)[0].toLowerCase();
    return base.endsWith(".mp4");
  };

  const normalizeUrl = (url) => {
    if (!url || typeof url !== "string") return "";
    if (url.startsWith("http")) return url;
    if (url.startsWith("users/") || url.startsWith("/users/")) {
      const trimmed = url.replace(/^\//, "");
      return `https://assets.grok.com/${trimmed}`;
    }
    return url;
  };



  const extractItems = (posts) => {
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

  const fetchPage = async (source, cursor) => {
    const body = {
      limit: LIMIT,
      filter: { source }
    };
    if (cursor) body.cursor = cursor;
    const response = await fetch(LIST_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const fetchAllForSource = async (source) => {
    let cursor = undefined;
    let all = [];
    while (true) {
      const data = await fetchPage(source, cursor);
      const posts = data && data.posts ? data.posts : [];
      all = all.concat(extractItems(posts));
      cursor = data && data.nextCursor ? data.nextCursor : undefined;
      if (!cursor || posts.length === 0) break;
    }
    return all;
  };

  const pickOwnedSource = async () => {
    const userId = getUserId();
    if (!userId) return "";
    for (let i = 0; i < SOURCE_CANDIDATES.length; i += 1) {
      const source = SOURCE_CANDIDATES[i];
      try {
        const data = await fetchPage(source);
        const posts = data && data.posts ? data.posts : [];
        const hasOwn = posts.some((post) => post.userId === userId);
        if (hasOwn) return source;
      } catch (error) {
        // ignore
      }
    }
    return "";
  };

  const dedupeItems = (items) => {
    const map = new Map();
    (items || []).forEach((item) => {
      if (!item || !item.url) return;
      const key = item.postId || item.id || item.url;
      if (!map.has(key)) map.set(key, item);
    });
    return Array.from(map.values());
  };

  const fullResync = async () => {
    const likedItems = await fetchAllForSource(SOURCE_LIKED);
    const ownedSource = await pickOwnedSource();
    let combined = likedItems;
    if (ownedSource) {
      const ownedItems = await fetchAllForSource(ownedSource);
      combined = combined.concat(ownedItems);
    }
    const deduped = dedupeItems(combined);
    chrome.storage.local.set(
      {
        [STORAGE_KEY]: {
          items: deduped,
          updatedAt: Date.now()
        }
      },
      () => {}
    );
    return deduped;
  };

  const deletePost = async (videoId) => {
    if (!videoId) return { ok: false, status: 0 };
    chrome.runtime.sendMessage({
      action: "grokViewerDeleteProgress",
      postId: videoId,
      index: 0,
      total: 0,
      ok: false,
      status: 0,
      note: "delete-start"
    });
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerDeleteViaMain", id: videoId }, (result) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, status: 0, body: chrome.runtime.lastError.message });
          return;
        }
        resolve(result || { ok: false, status: 0, body: "" });
      });
    });
    chrome.runtime.sendMessage({
      action: "grokViewerDeleteProgress",
      postId: videoId,
      index: 0,
      total: 0,
      ok: response.ok,
      status: response.status,
      note: "delete-result"
    });
    if (!response.ok) {
    } else {
    }
    return response;
  };

  const deletePostsSequential = async (videoIds) => {
    const unique = Array.from(new Set((videoIds || []).filter(Boolean)));
    const deleted = [];
    const failed = [];
    for (let i = 0; i < unique.length; i += 1) {
      const videoId = unique[i];
      try {
        const result = await deletePost(videoId);
        chrome.runtime.sendMessage({
          action: "grokViewerDeleteProgress",
          postId: videoId,
          index: i + 1,
          total: unique.length,
          ok: result.ok,
          status: result.status
        });
        if (result.ok) {
          deleted.push(videoId);
        } else if (result.status === 429) {
          await sleep(600);
          failed.push(videoId);
        } else {
          failed.push(videoId);
        }
      } catch (error) {
        chrome.runtime.sendMessage({
          action: "grokViewerDeleteProgress",
          postId: videoId,
          index: i + 1,
          total: unique.length,
          ok: false,
          status: 0
        });
        failed.push(videoId);
      }
      await sleep(180);
    }
    return { deleted, failed };
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === "grokViewerDeleteOne") {
      deletePost(message.postId)
        .then((result) => {
          sendResponse({ ok: result.ok, status: result.status });
        })
        .catch(() => {
          sendResponse({ ok: false, status: 0 });
        });
      return true;
    }
    if (message && message.action === "grokViewerDeleteAll") {
      deletePostsSequential(message.postIds)
        .then((result) => {
          sendResponse({ ok: true, deleted: result.deleted, failed: result.failed, response: { ok: true } });
        })
        .catch(() => {
          sendResponse({ ok: false, deleted: [], failed: message.postIds || [] });
        });
      return true;
    }
    if (message && message.action === "grokViewerFullSync") {
      chrome.storage.local.set({ [STORAGE_KEY]: { items: [], updatedAt: Date.now() } }, () => {
        fullResync()
          .then((items) => sendResponse({ ok: true, count: items.length }))
          .catch(() => sendResponse({ ok: false }));
      });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(STORAGE_KEY, (data) => {
    const items = data && data[STORAGE_KEY] && data[STORAGE_KEY].items ? data[STORAGE_KEY].items : [];
    if (!items.length) {
      fullResync().catch(() => {});
    }
  });
})();
