(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const API_URL = "/rest/media/post/list";
  const DELETE_URL = "/rest/media/post/delete";
  const LIKE_URL = "/rest/media/post/like";
  const UNLIKE_URL = "/rest/media/post/unlike";
  const LIMIT = 40;
  const SOURCE = "MEDIA_POST_SOURCE_LIKED";

  if (!location.pathname.startsWith("/imagine/favorites")) return;
  const params = new URLSearchParams(location.search);
  if (!params.has("grokViewer")) return;
  if (window.__grokViewerEmbedLoaded) return;
  window.__grokViewerEmbedLoaded = true;

  const state = {
    items: [],
    videoItems: [],
    imageItems: [],
    mode: "videos",
    selectedIndex: 0,
    busy: false,
    logsOpen: false,
    lastUpdatedAt: 0,
    knownUrls: new Set(),
    autoAdvance: false,
    thumbAutoplay: false,
    sortOrder: "desc",
    renderToken: 0
  };

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
        const changed = stored && stored !== currentKey;
        chrome.storage.local.set({ grokViewerUserId: currentKey }, () => {
          lastUserKey = currentKey;
          if (changed) {
            updateItems([], []);
          }
          resolve(changed);
        });
      });
    });

  let logTimer = null;
  const logLines = [];
  const MAX_LOGS = 200;

  const formatTime = (date) =>
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
      date.getSeconds()
    ).padStart(2, "0")}`;

  const addLog = () => {};

  const fetchPage = async (cursor) => {
    const body = {
      limit: LIMIT,
      filter: { source: SOURCE }
    };
    if (cursor) body.cursor = cursor;
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

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
      return url;
    }
  };

  const isMp4 = (url, mimeType) => {
    if (mimeType === "video/mp4") return true;
    return (url || "").toLowerCase().includes(".mp4");
  };

  const isImage = (url, mimeType) => {
    if (mimeType && mimeType.startsWith("image/")) return true;
    const base = (url || "").split(/[?#]/)[0].toLowerCase();
    return base.endsWith(".jpg") || base.endsWith(".jpeg") || base.endsWith(".png") || base.endsWith(".webp");
  };

  const buildItem = (post, parentPostId, parentImageUrl, parentPrompt) => {
    if (!post) return null;
    const rawUrl = post.hdMediaUrl || post.mediaUrl || "";
    if (!isMp4(rawUrl, post.mimeType)) return null;
    const url = normalizeUrl(rawUrl);
    if (!isMp4(url, post.mimeType)) return null;
    const poster = normalizeUrl(post.thumbnailImageUrl || post.previewImageUrl || "");
    const promptCandidateRaw =
      post.originalPrompt ||
      post.prompt ||
      post.promptText ||
      post.promptMessage ||
      post.promptUserMessage ||
      post.userPrompt ||
      post.generationPrompt ||
      (post.prompt && post.prompt.text) ||
      (post.prompt && post.prompt.content) ||
      post.textPrompt ||
      parentPrompt ||
      "";
    const promptCandidate =
      typeof promptCandidateRaw === "string" ? promptCandidateRaw.trim() : promptCandidateRaw ? String(promptCandidateRaw) : "";
    const explicitHasPrompt =
      post.hasPrompt === true ||
      post.canRepeat === true ||
      post.repeatable === true ||
      post.hasUserPrompt === true ||
      post.promptAvailable === true ||
      post.promptPresent === true;
    const explicitNoPrompt =
      post.hasPrompt === false ||
      post.canRepeat === false ||
      post.repeatable === false ||
      post.hasUserPrompt === false ||
      post.promptAvailable === false ||
      post.promptPresent === false;
    const looksLikeImagePrompt = /imagine-public\.x\.ai\/imagine-public\/images\//i.test(promptCandidate || "");
    const hasPrompt = explicitHasPrompt
      ? true
      : explicitNoPrompt
      ? false
      : looksLikeImagePrompt
      ? false
      : promptCandidate
      ? true
      : post.parentPostId || post.originalPostId || post.parentPost
      ? false
      : null;
    return {
      id: post.id || url,
      url,
      poster,
      postId: post.id || "",
      parentPostId: post.parentPostId || parentPostId || post.originalPostId || "",
      sourceImageUrl: normalizeUrl(parentImageUrl || ""),
      promptText: looksLikeImagePrompt ? "" : promptCandidate,
      hasPrompt,
      createdAt: post.createTime || post.createdAt || ""
    };
  };

  const buildImageItem = (post) => {
    if (!post) return null;
    const rawUrl = post.mediaUrl || "";
    if (!isImage(rawUrl, post.mimeType)) return null;
    const url = normalizeUrl(rawUrl);
    if (!isImage(url, post.mimeType)) return null;
    const childVideoIds = [];
    (post.childPosts || []).forEach((child) => {
      if (!child) return;
      const childUrl = child.hdMediaUrl || child.mediaUrl || "";
      if (child.id && (isMp4(childUrl, child.mimeType) || child.mediaType === "MEDIA_POST_TYPE_VIDEO")) {
        childVideoIds.push(child.id);
      }
    });
    (post.videos || []).forEach((video) => {
      if (!video) return;
      const videoUrl = video.hdMediaUrl || video.mediaUrl || "";
      if (video.id && (isMp4(videoUrl, video.mimeType) || video.mediaType === "MEDIA_POST_TYPE_VIDEO")) {
        childVideoIds.push(video.id);
      }
    });
    return {
      id: post.id || url,
      url,
      poster: url,
      postId: post.id || "",
      createdAt: post.createTime || post.createdAt || "",
      childVideoIds
    };
  };

  const extractItems = (posts) => {
    const videos = [];
    const images = [];
    (posts || []).forEach((post) => {
      const imageItem = buildImageItem(post);
      if (imageItem) images.push(imageItem);
      const mainItem = buildItem(post);
      if (mainItem) videos.push(mainItem);
      const parentImageUrl = post && post.mediaUrl ? post.mediaUrl : "";
      const parentPrompt = post && (post.originalPrompt || post.prompt) ? post.originalPrompt || post.prompt : "";
      (post.videos || []).forEach((video) => {
        const videoItem = buildItem(video, post.id || "", parentImageUrl, parentPrompt);
        if (videoItem) videos.push(videoItem);
      });
      (post.childPosts || []).forEach((child) => {
        const childItem = buildItem(child, post.id || "", parentImageUrl, parentPrompt);
        if (childItem) videos.push(childItem);
      });
    });
    return { videos, images };
  };

  const stripUrlForKey = (url) => {
    if (!url || typeof url !== "string") return "";
    const base = url.split(/[?#]/)[0].toLowerCase();
    return base;
  };

  const extractMp4Id = (url) => {
    if (!url) return "";
    const match = url.match(/\/generated\/([0-9a-f-]{36})\/generated_video\.mp4/i);
    return match ? match[1] : "";
  };

  const extractImageId = (url) => {
    if (!url) return "";
    const match = url.match(/imagine-public\/images\/([0-9a-f-]{36})\.(?:jpg|jpeg|png|webp)/i);
    return match ? match[1] : "";
  };

  const getItemKey = (item) => {
    if (!item) return "";
    if (item.postId) return `post:${item.postId}`;
    const mp4Id = extractMp4Id(item.url || "");
    if (mp4Id) return `mp4:${mp4Id}`;
    if (item.url) return `url:${stripUrlForKey(item.url)}`;
    return "";
  };

  const buildKeySet = (items) => {
    const set = new Set();
    (items || []).forEach((item) => {
      const key = getItemKey(item);
      if (key) set.add(key);
    });
    return set;
  };

  const mergeItemDetails = (base, extra) => {
    const merged = { ...base };
    if (!merged.sourceImageUrl && extra.sourceImageUrl) merged.sourceImageUrl = extra.sourceImageUrl;
    if (!merged.promptText && extra.promptText) merged.promptText = extra.promptText;
    if (!merged.parentPostId && extra.parentPostId) merged.parentPostId = extra.parentPostId;
    if (merged.hasPrompt === null || merged.hasPrompt === undefined) {
      if (extra.hasPrompt !== null && extra.hasPrompt !== undefined) merged.hasPrompt = extra.hasPrompt;
    }
    return merged;
  };

  const pickBetterItem = (current, next) => {
    if (!current) return next;
    if (!next) return current;
    const currentHasUrl = Boolean(current.url);
    const nextHasUrl = Boolean(next.url);
    if (currentHasUrl !== nextHasUrl) {
      const primary = nextHasUrl ? next : current;
      const secondary = nextHasUrl ? current : next;
      return mergeItemDetails(primary, secondary);
    }
    const currentTime = current.createdAt ? Date.parse(current.createdAt) : 0;
    const nextTime = next.createdAt ? Date.parse(next.createdAt) : 0;
    if (nextTime !== currentTime) {
      const primary = nextTime > currentTime ? next : current;
      const secondary = nextTime > currentTime ? current : next;
      return mergeItemDetails(primary, secondary);
    }
    if (!current.poster && next.poster) return mergeItemDetails(next, current);
    if (!current.parentPostId && next.parentPostId) return mergeItemDetails(next, current);
    return mergeItemDetails(current, next);
  };

  const dedupeItems = (items) => {
    const map = new Map();
    (items || []).forEach((item) => {
      if (!item) return;
      const postIdKey = item.postId ? `post:${item.postId}` : "";
      const mp4Id = extractMp4Id(item.url || "");
      const mp4Key = mp4Id ? `mp4:${mp4Id}` : "";
      const urlKey = item.url ? `url:${stripUrlForKey(item.url)}` : "";
      const key = postIdKey || mp4Key || urlKey;
      if (!key) return;
      const existing = map.get(key);
      map.set(key, pickBetterItem(existing, item));
    });
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });
  };

  const dedupeImageItems = (items) => {
    const map = new Map();
    (items || []).forEach((item) => {
      if (!item) return;
      const key = item.postId ? `post:${item.postId}` : item.url ? `url:${stripUrlForKey(item.url)}` : "";
      if (!key) return;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, item);
        return;
      }
      const ta = existing.createdAt ? Date.parse(existing.createdAt) : 0;
      const tb = item.createdAt ? Date.parse(item.createdAt) : 0;
      map.set(key, tb > ta ? item : existing);
    });
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });
  };

  const fetchAll = async () => {
    let cursor = undefined;
    let allVideos = [];
    let allImages = [];
    const seen = new Set();
    let safety = 0;
    while (true) {
      const data = await fetchPage(cursor);
      const posts = data && data.posts ? data.posts : [];
      const extracted = extractItems(posts);
      allVideos = allVideos.concat(extracted.videos || []);
      allImages = allImages.concat(extracted.images || []);
      const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
      if (!nextCursor) break;
      if (seen.has(nextCursor)) break;
      seen.add(nextCursor);
      cursor = nextCursor;
      safety += 1;
      if (safety > 200) break;
    }
    return { videos: allVideos, images: allImages };
  };

  const toTime = (value) => {
    const t = Date.parse(value || "");
    return Number.isFinite(t) ? t : 0;
  };

  const sortByCreatedAt = (items) => {
    const direction = state.sortOrder === "asc" ? 1 : -1;
    return (items || [])
      .slice()
      .sort((a, b) => (toTime(a.createdAt) - toTime(b.createdAt)) * direction);
  };

  const computeCurrentItems = () => {
    const base = state.mode === "images" ? state.imageItems : state.videoItems;
    return sortByCreatedAt(base);
  };

  const updateItems = (videos, images) => {
    state.videoItems = dedupeItems(videos || []);
    state.imageItems = dedupeImageItems(images || []);
    state.items = computeCurrentItems();
    state.lastUpdatedAt = Date.now();
    const nextUrls = new Set(state.videoItems.map((item) => item.url));
    nextUrls.forEach((url) => {
      if (!state.knownUrls.has(url)) addLog(`New video: ${url}`);
    });
    state.knownUrls.forEach((url) => {
      if (!nextUrls.has(url)) addLog(`Removed video: ${url}`);
    });
    state.knownUrls = nextUrls;
    renderGrid();
    updateCount();
  };

  const refresh = async () => {
    if (state.busy) return;
    state.busy = true;
    setStatus("Refreshing favorites...");
    addLog("Refresh requested");
    try {
      await ensureUserScope();
      const result = await fetchAll();
      const videos = result && result.videos ? result.videos : [];
      const images = result && result.images ? result.images : [];
      updateItems(videos, images);
      chrome.storage.local.set({ [STORAGE_KEY]: { items: videos, updatedAt: Date.now() } }, () => {});
      addLog("Refresh completed");
      setStatus("Ready.");
    } catch (error) {
      addLog(`Refresh failed: ${error.message}`);
      setStatus("Refresh failed.");
    } finally {
      state.busy = false;
      updateActionButtons();
    }
  };

  const sendToFavorites = (payload) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerProxyToTab", payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const deletePostDirect = async (postId) => {
    if (!postId) return { ok: false };
    const response = await fetch(DELETE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    return { ok: response.ok, status: response.status };
  };

  const deletePost = async (postId) => {
    if (!postId) return { ok: false };
    try {
      const direct = await deletePostDirect(postId);
      if (direct.ok) return direct;
    } catch (error) {
      // ignore and fallback
    }
    const result = await sendToFavorites({ action: "grokViewerDeleteOne", postId });
    if (!result || !result.ok || !result.response) {
      return { ok: false };
    }
    return { ok: Boolean(result.response.ok), status: result.response.status };
  };

  const likePostDirect = async (postId) => {
    if (!postId) return { ok: false };
    const response = await fetch(LIKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    return { ok: response.ok, status: response.status };
  };

  const likePost = async (postId) => {
    if (!postId) return { ok: false };
    try {
      const direct = await likePostDirect(postId);
      return direct;
    } catch (error) {
      return { ok: false };
    }
  };

  const unlikePostDirect = async (postId) => {
    if (!postId) return { ok: false };
    const response = await fetch(UNLIKE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    return { ok: response.ok, status: response.status };
  };

  const unlikePost = async (postId) => {
    if (!postId) return { ok: false };
    try {
      const direct = await unlikePostDirect(postId);
      if (direct.ok) return direct;
    } catch (error) {
      return { ok: false };
    }
    return { ok: false };
  };

  const deleteItem = async (item) => {
    if (!item || !item.postId || state.busy) return;
    state.busy = true;
    const isImages = state.mode === "images" && item.url && isImage(item.url, item.mimeType);
    setStatus(isImages ? "Deleting image..." : "Deleting video...");
    showToast(isImages ? "Deleting image..." : "Deleting video...");
    setThumbStatus(item.postId, "deleting", "Deleting...");
    if (isImages) {
      const childIds = Array.from(new Set((item.childVideoIds || []).filter(Boolean)));
      for (let i = 0; i < childIds.length; i += 1) {
        const res = await likePost(childIds[i]);
        if (!res.ok) {
          state.busy = false;
          setStatus("Delete failed.");
          showToast("Delete failed.", "error");
          setThumbStatus(item.postId, "failed", "Failed");
          updateActionButtons();
          return;
        }
        await sleep(140);
      }
    }
    const result = isImages ? await unlikePost(item.postId) : await deletePost(item.postId);
    state.busy = false;
    if (!result.ok) {
      setStatus("Delete failed.");
      showToast("Delete failed.", "error");
      setThumbStatus(item.postId, "failed", "Failed");
      updateActionButtons();
      return;
    }
    if (isImages) {
      const nextImages = state.imageItems.filter((entry) => entry.postId !== item.postId);
      updateItems(state.videoItems, nextImages);
      setStatus("Image deleted.");
    } else {
      const nextVideos = state.videoItems.filter((entry) => entry.postId !== item.postId);
      updateItems(nextVideos, state.imageItems);
      setStatus("Video deleted.");
    }
    showToast("DELETED");
    updateActionButtons();
  };

  const deleteOne = async () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    deleteItem(item);
  };

  const deleteAll = async () => {
    if (state.mode === "images") {
      if (state.busy) return;
      if (!window.confirm("Delete images from favorites?")) return;
      state.busy = true;
      updateActionButtons();
      setStatus("Deleting all images...");
      showToast("Deleting images...");
      let failed = [];
      let last = null;
      let cycle = 0;
      while (cycle < 6) {
        const result = await fetchAll();
        last = result;
        const images = (result && result.images ? result.images : []).filter(
          (item) => item && item.postId && item.url && isImage(item.url, item.mimeType)
        );
        if (!images.length) break;
        const childIds = Array.from(
          new Set(
            images
              .flatMap((item) => item.childVideoIds || [])
              .filter(Boolean)
          )
        );
        for (let i = 0; i < childIds.length; i += 1) {
          const res = await likePost(childIds[i]);
          if (!res.ok) {
            state.busy = false;
            setStatus("Delete images failed.");
            showToast("Delete images failed.", "error");
            updateActionButtons();
            return;
          }
          await sleep(140);
        }
        const toDelete = images.map((item) => item.postId);
        failed = [];
        for (let i = 0; i < toDelete.length; i += 1) {
          const res = await unlikePost(toDelete[i]);
          if (!res.ok) failed.push(toDelete[i]);
          await sleep(180);
        }
        cycle += 1;
        if (failed.length === toDelete.length) break;
        await sleep(350);
      }
      if (last) {
        const videos = last && last.videos ? last.videos : state.videoItems;
        const images = last && last.images ? last.images : state.imageItems;
        updateItems(videos, images);
      }
      state.busy = false;
      setStatus(failed.length ? `Failed ${failed.length} deletions.` : "All deletions requested.");
      if (failed.length) {
        showToast("Some deletions failed.", "error");
      } else {
        showToast("DELETED");
      }
      failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
      if (!failed.length) {
        setStatus("Purging cache...");
        purgeCache({ confirm: false, reload: true, silent: true });
        return;
      }
      updateActionButtons();
      return;
    }
    if (state.busy) return;
    if (!window.confirm("Delete all videos from favorites?")) return;
    state.busy = true;
    updateActionButtons();
    setStatus("Deleting all videos...");
    showToast("Deleting videos...");
    const toDelete = state.items.map((item) => item.postId).filter(Boolean);
    toDelete.forEach((id) => setThumbStatus(id, "deleting", "Deleting..."));
    const failed = [];
    for (let i = 0; i < toDelete.length; i += 1) {
      const result = await deletePost(toDelete[i]);
      if (!result.ok) failed.push(toDelete[i]);
      await sleep(180);
    }
    const remaining = state.videoItems.filter((item) => failed.includes(item.postId));
    updateItems(remaining, state.imageItems);
    state.busy = false;
    setStatus(failed.length ? `Failed ${failed.length} deletions.` : "All deletions requested.");
    if (failed.length) {
      showToast("Some deletions failed.", "error");
    } else {
      showToast("DELETED");
    }
    failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
    updateActionButtons();
  };

  const pickDownloadUrl = (item) => {
    if (!item) return "";
    if (item.hdMediaUrl) return item.hdMediaUrl;
    return item.url || "";
  };

  const fetchWithBestCreds = async (url) => {
    if (!url) return null;
    const isPublic = url.includes("imagine-public.x.ai");
    const response = await fetch(url, {
      credentials: isPublic ? "omit" : "include"
    });
    return response;
  };

  const fetchWithTimeout = async (url, timeoutMs) => {
    if (!url) throw new Error("missing-url");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const isPublic = url.includes("imagine-public.x.ai");
      const response = await fetch(url, {
        credentials: isPublic ? "omit" : "include",
        signal: controller.signal
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  const downloadViaExtension = (url) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerDownloadUrl", url }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const downloadFile = async (item) => {
    if (!item) return;
    const targetUrl = pickDownloadUrl(item);
    const isImg = isImage(targetUrl, item.mimeType);
    const baseUrl = (targetUrl || "").split(/[?#]/)[0];
    const extMatch = baseUrl.match(/\.([a-z0-9]{2,6})$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "bin";
    const filenameBase = item.postId || item.id || "grok-media";
    const filename = `${filenameBase}.${ext}`;
    try {
      const response = await fetchWithBestCreds(targetUrl);
      if (!response || !response.ok) throw new Error("fetch-failed");
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      link.click();
      await waitForDownload(filename, true);
      showDownloadReady(
        `Click here to see your ${isImg ? "Image" : "Video"} downloaded`,
        filename
      );
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (error) {
      const fallback = await downloadViaExtension(targetUrl);
      if (!fallback || !fallback.ok) {
        setStatus("Download failed.");
        return;
      }
      await waitForDownload(filename, true);
      showDownloadReady(
        `Click here to see your ${isImg ? "Image" : "Video"} downloaded`,
        filename
      );
    }
  };

  const downloadOne = () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    downloadFile(item);
  };

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  const crc32 = (data) => {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i += 1) {
      const byte = data[i];
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };

  const toDosTimeDate = (date) => {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);
    const dosTime = (hours << 11) | (minutes << 5) | seconds;
    const dosDate = ((year - 1980) << 9) | (month << 5) | day;
    return { dosTime, dosDate };
  };

  const buildZipBlob = (files) => {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const header = new Uint8Array(30 + nameBytes.length);
      const headerView = new DataView(header.buffer);
      headerView.setUint32(0, 0x04034b50, true);
      headerView.setUint16(4, 20, true);
      headerView.setUint16(6, 0, true);
      headerView.setUint16(8, 0, true);
      headerView.setUint16(10, file.dosTime, true);
      headerView.setUint16(12, file.dosDate, true);
      headerView.setUint32(14, file.crc, true);
      headerView.setUint32(18, file.size, true);
      headerView.setUint32(22, file.size, true);
      headerView.setUint16(26, nameBytes.length, true);
      headerView.setUint16(28, 0, true);
      header.set(nameBytes, 30);
      localParts.push(header, file.data);

      const central = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, file.dosTime, true);
      centralView.setUint16(14, file.dosDate, true);
      centralView.setUint32(16, file.crc, true);
      centralView.setUint32(20, file.size, true);
      centralView.setUint32(24, file.size, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += header.length + file.size;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
  };

  const downloadAll = () => {
    if (state.busy || !state.items.length) return;
    const isImages = state.mode === "images";
    state.busy = true;
    updateActionButtons();
    setStatus(isImages ? "Preparing image archive..." : "Preparing archive...");
    showDownloadProgress();
    const run = async () => {
      try {
        const total = state.items.length;
        const batchSize = total > 80 ? 15 : total > 45 ? 25 : total;
        const batches = [];
        for (let i = 0; i < total; i += batchSize) {
          batches.push(state.items.slice(i, i + batchSize));
        }
        const baseTime = Date.now();
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex];
          const files = [];
          const queue = batch.map((item) => ({ item, tries: 0 }));
          const concurrency = Math.min(
            total > 80 ? 2 : 3,
            Math.max(1, navigator.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 3)
          );
          let completed = 0;
          let failedCount = 0;
          const fetchOne = async () => {
            while (queue.length) {
              const entry = queue.shift();
              if (!entry || !entry.item) continue;
              const targetUrl = entry.item.hdMediaUrl || entry.item.url;
              let response;
              try {
                response = await fetchWithTimeout(targetUrl, 60000);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
              } catch (error) {
                if (entry.tries < 2) {
                  queue.push({ item: entry.item, tries: entry.tries + 1 });
                  await sleep(300);
                  continue;
                }
                failedCount += 1;
                setStatus(
                  `${isImages ? "Preparing image archive" : "Preparing archive"} ${batchIndex + 1}/${batches.length}... ${completed}/${batch.length} (retrying)`
                );
                await sleep(350);
                continue;
              }
              const buffer = new Uint8Array(await response.arrayBuffer());
              const { dosTime, dosDate } = toDosTimeDate(new Date());
              const baseUrl = (entry.item.url || "").split(/[?#]/)[0];
              const extMatch = baseUrl.match(/\\.([a-z0-9]{2,6})$/i);
              const ext = extMatch ? extMatch[1].toLowerCase() : isImages ? "jpg" : "mp4";
              const name = `${entry.item.postId || entry.item.id}.${ext}`;
              files.push({
                name,
                data: buffer,
                size: buffer.length,
                crc: crc32(buffer),
                dosTime,
                dosDate
              });
              completed += 1;
              const prepText = `${isImages ? "Preparing image archive" : "Preparing archive"} ${batchIndex + 1}/${batches.length}... ${completed}/${batch.length}`;
              setStatus(prepText);
              setDownloadProgress(prepText, completed / batch.length);
              if (failedCount && failedCount % 4 === 0) await sleep(250);
            }
          };
          const workers = [];
          for (let i = 0; i < concurrency; i += 1) {
            workers.push(fetchOne());
          }
          await Promise.all(workers);
          if (!files.length) continue;
          const buildText = `${isImages ? "Building image archive" : "Building archive"} ${batchIndex + 1}/${batches.length}...`;
          setStatus(buildText);
          setDownloadProgress(buildText, 1);
          const blob = buildZipBlob(files);
          const prefix = isImages ? "grok-images" : "grok-videos";
          const archiveName =
            batches.length > 1
              ? `${prefix}-${baseTime}-part-${batchIndex + 1}.zip`
              : `${prefix}-${baseTime}.zip`;
          const blobUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = blobUrl;
          link.download = archiveName;
          link.click();
          const downloadText =
            batches.length > 1
              ? `Click here to see your Archive ${batchIndex + 1} downloaded`
              : "Click here to see your Archive downloaded";
          const startText = `Starting download of archive ${batchIndex + 1}...`;
          setStatus(startText);
          setDownloadProgress(startText, 0);
          await waitForDownload(archiveName, true);
          showDownloadReady(downloadText, archiveName);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
          await sleep(350);
        }
        setStatus(isImages ? "Image archive download started." : "Archive download started.");
      } catch (error) {
        setStatus("Download all failed.");
      } finally {
        state.busy = false;
        hideDownloadProgress(6000);
        updateActionButtons();
      }
    };
    run();
  };

  let root;
  let statusEl;
  let gridEl;
  let emptyEl;
  let countEl;
  let refreshBtn;
  let downloadAllBtn;
  let deleteAllBtn;
  let hideModToastToggle;
  let downloadReadyEl;
  let downloadReadyAudio;
  let downloadProgressEl;
  let downloadProgressText;
  let downloadProgressFill;
  let githubBtn;
  let lastDownloadFilename = "";
  let logsBtn;
  let logsPanel;
  let logsBody;
  let clearLogsBtn;
  let purgeBtn;
  let logsCloseBtn;
  let thumbAutoplayBtn;
  let sortBtn;
  let tabVideosBtn;
  let tabImagesBtn;
  let lightboxEl;
  let lightboxCountEl;
  let closeBtn;
  let fullscreenBtn;
  let downloadBtn;
  let deleteBtn;
  let autoNextBtn;
  let prevBtn;
  let nextBtn;
  let playerEl;
  let imageEl;
  let toastEl;
  let toastText;

  const updateCount = () => {
    const total = state.items.length;
    if (countEl) {
      const label = state.mode === "images" ? "image" : "video";
      countEl.textContent = `Loaded ${total} ${label}${total === 1 ? "" : "s"}`;
    }
    if (lightboxCountEl) {
      const current = total ? state.selectedIndex + 1 : 0;
      lightboxCountEl.textContent = `${current} / ${total}`;
    }
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  let downloadReadyTimer = null;
  const showDownloadReady = (label, filename) => {
    if (!downloadReadyEl) return;
    if (label) downloadReadyEl.textContent = label;
    if (filename) lastDownloadFilename = filename;
    downloadReadyEl.style.display = "inline-flex";
    if (downloadReadyTimer) clearTimeout(downloadReadyTimer);
    downloadReadyTimer = setTimeout(() => {
      downloadReadyEl.style.display = "none";
    }, 7000);
    if (downloadReadyAudio) {
      try {
        downloadReadyAudio.currentTime = 0;
        const playPromise = downloadReadyAudio.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
      } catch (e) {}
    }
  };

  const openDownloadsFolder = (filename) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerOpenDownloads", filename }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const waitForDownload = (filename, requireComplete) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "grokViewerWaitForDownload", filename, requireComplete: !!requireComplete },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        }
      );
    });

  let downloadProgressTimer = null;
  const showDownloadProgress = () => {
    if (downloadProgressTimer) clearTimeout(downloadProgressTimer);
    if (downloadProgressEl) downloadProgressEl.classList.add("show");
    if (githubBtn) githubBtn.classList.add("hidden");
  };

  const hideDownloadProgress = (delayMs) => {
    if (downloadProgressTimer) clearTimeout(downloadProgressTimer);
    const run = () => {
      if (downloadProgressEl) downloadProgressEl.classList.remove("show");
      if (githubBtn) githubBtn.classList.remove("hidden");
      if (downloadProgressFill) downloadProgressFill.style.width = "0%";
    };
    if (delayMs && delayMs > 0) {
      downloadProgressTimer = setTimeout(run, delayMs);
      return;
    }
    run();
  };

  const setDownloadProgress = (text, ratio) => {
    if (downloadProgressText) downloadProgressText.textContent = text || "";
    if (downloadProgressFill) {
      const pct = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));
      downloadProgressFill.style.width = `${pct}%`;
    }
  };

  let toastTimer = null;
  const showToast = (message, type) => {
    if (!toastEl || !toastText) return;
    toastText.textContent = message;
    toastEl.classList.remove("hide", "error");
    if (type === "error") toastEl.classList.add("error");
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      toastEl.classList.add("hide");
    }, 1600);
  };

  const applyModeUI = () => {
    const isImages = state.mode === "images";
    if (tabVideosBtn) tabVideosBtn.classList.toggle("active", !isImages);
    if (tabImagesBtn) tabImagesBtn.classList.toggle("active", isImages);
    if (autoNextBtn) autoNextBtn.style.display = isImages ? "none" : "";
    if (downloadAllBtn) downloadAllBtn.textContent = "Download All";
    if (deleteAllBtn) deleteAllBtn.textContent = "Delete All";
    if (thumbAutoplayBtn) {
      thumbAutoplayBtn.style.display = isImages ? "none" : "";
      thumbAutoplayBtn.textContent = state.thumbAutoplay ? "Stop autoplay in thumbnails" : "Start autoplay in thumbnails";
    }
    if (sortBtn) {
      sortBtn.style.display = isImages ? "none" : "";
      sortBtn.textContent = state.sortOrder === "asc" ? "Sort by time (oldest)" : "Sort by time (newest)";
    }
  };

  const setMode = (mode) => {
    if (mode !== "videos" && mode !== "images") return;
    if (state.mode === mode) return;
    state.mode = mode;
    state.items = computeCurrentItems();
    state.selectedIndex = 0;
    applyModeUI();
    renderGrid();
    updateCount();
    updateActionButtons();
  };

  const updateActionButtons = () => {
    const selected = state.items[state.selectedIndex];
    const canDelete = Boolean(selected && selected.postId);
    const isImages = state.mode === "images";
    if (downloadBtn) downloadBtn.disabled = !selected || state.busy;
    if (deleteBtn) deleteBtn.disabled = !canDelete || state.busy;
    if (downloadAllBtn) {
      const hasItems = isImages ? state.imageItems.length : state.videoItems.length;
      downloadAllBtn.disabled = !hasItems || state.busy;
    }
    if (deleteAllBtn) deleteAllBtn.disabled = isImages ? !state.imageItems.length || state.busy : !state.videoItems.length || state.busy;
    if (autoNextBtn) autoNextBtn.classList.toggle("active", !isImages && state.autoAdvance);
  };

  const purgeCache = (options = {}) => {
    const confirmFirst = options.confirm !== false;
    const reload = options.reload !== false;
    const silent = options.silent === true;
    if (confirmFirst && !window.confirm("Purge cached list? This won't delete downloaded files.")) return false;
    chrome.storage.local.remove(STORAGE_KEY, () => {
      state.items = [];
      state.videoItems = [];
      state.imageItems = [];
      state.selectedIndex = 0;
      state.busy = false;
      state.knownUrls = new Set();
      if (gridEl) gridEl.innerHTML = "";
      if (emptyEl) emptyEl.classList.add("show");
      if (playerEl) {
        try {
          playerEl.pause();
          playerEl.removeAttribute("src");
          playerEl.load();
        } catch (e) {}
      }
      closeLightbox();
      if (!silent) setStatus("Cache purged. Reloading...");
      if (reload) {
        setTimeout(() => {
          window.location.reload();
        }, 60);
      } else {
        updateActionButtons();
      }
    });
    return true;
  };

  const setThumbStatus = (postId, stateName, label) => {
    if (!postId || !gridEl) return;
    const thumb = gridEl.querySelector(`.thumb[data-post-id="${postId}"]`);
    if (!thumb) return;
    thumb.classList.remove("deleting");
    const statusEl = thumb.querySelector(".thumb-status");
    if (statusEl) statusEl.textContent = label || "";
    if (stateName === "deleting") {
      thumb.classList.add("deleting");
    }
  };

  let thumbObserver = null;
  const ensureThumbObserver = () => {
    if (thumbObserver) return thumbObserver;
    thumbObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const el = entry.target;
          if (!el || el.tagName !== "VIDEO") return;
          if (!state.thumbAutoplay) {
            try {
              el.pause();
            } catch (e) {}
            return;
          }
          if (entry.isIntersecting) {
            const src = el.dataset.src || "";
            if (src && !el.src) {
              el.src = src;
              try {
                el.load();
              } catch (e) {}
            }
            const p = el.play();
            if (p && typeof p.catch === "function") p.catch(() => {});
          } else {
            try {
              el.pause();
            } catch (e) {}
          }
        });
      },
      { root: null, rootMargin: "120px 0px 120px 0px", threshold: 0.01 }
    );
    return thumbObserver;
  };

  const scheduleWork = (cb) => {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => cb(), { timeout: 120 });
      return;
    }
    window.requestAnimationFrame(cb);
  };

  const renderGrid = () => {
    if (!gridEl) return;
    const token = (state.renderToken += 1);
    gridEl.innerHTML = "";
    if (!state.items.length) {
      if (emptyEl) emptyEl.classList.add("show");
      const emptyTitle = emptyEl ? emptyEl.querySelector("h2") : null;
      if (emptyTitle) emptyTitle.textContent = state.mode === "images" ? "No images yet" : "No videos yet";
      updateCount();
      updateActionButtons();
      return;
    }
    if (emptyEl) emptyEl.classList.remove("show");
    const items = state.items.slice();
    const mode = state.mode;
    updateCount();
    const chunkSize = 48;
    let index = 0;
    const renderChunk = () => {
      if (token !== state.renderToken) return;
      const fragment = document.createDocumentFragment();
      const end = Math.min(index + chunkSize, items.length);
      for (; index < end; index += 1) {
        const item = items[index];
        const card = document.createElement("div");
        card.className = "thumb-card";
        card.dataset.index = String(index);
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.dataset.index = String(index);
        if (item && item.postId) thumb.dataset.postId = item.postId;
        thumb.setAttribute("role", "button");
        thumb.tabIndex = 0;

        if (mode === "images") {
          const img = document.createElement("img");
          img.src = item.url;
          img.alt = "Generated image";
          img.loading = "lazy";
          img.decoding = "async";
          thumb.appendChild(img);
        } else if (state.thumbAutoplay) {
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.preload = "none";
          video.loop = true;
          video.autoplay = true;
          video.tabIndex = -1;
          if (item.poster) video.poster = item.poster;
          video.dataset.src = item.url;
          video.addEventListener("error", () => addLog(`Thumb error: ${item.url}`));
          thumb.appendChild(video);
          ensureThumbObserver().observe(video);
        } else {
          const img = document.createElement("img");
          if (item.poster) {
            img.src = item.poster;
            img.alt = "Generated video";
            img.loading = "lazy";
            img.decoding = "async";
            img.onerror = () => {
              if (img.dataset.fallback) return;
              img.dataset.fallback = "1";
              const video = document.createElement("video");
              video.muted = true;
              video.playsInline = true;
              video.preload = "metadata";
              video.loop = false;
              video.autoplay = false;
              video.tabIndex = -1;
              video.src = item.url;
              video.addEventListener("loadedmetadata", () => {
                try {
                  const target = Math.min(0.1, video.duration || 0);
                  if (target > 0) video.currentTime = target;
                } catch (e) {}
              });
              video.addEventListener("seeked", () => {
                try {
                  video.pause();
                } catch (e) {}
              });
              video.addEventListener("error", () => addLog(`Thumb error: ${item.url}`));
              if (img.parentNode) img.parentNode.replaceChild(video, img);
            };
            thumb.appendChild(img);
          } else {
            const video = document.createElement("video");
            video.muted = true;
            video.playsInline = true;
            video.preload = "metadata";
            video.loop = false;
            video.autoplay = false;
            video.tabIndex = -1;
            video.src = item.url;
            video.addEventListener("loadeddata", () => {
              try {
                video.pause();
              } catch (e) {}
            });
            video.addEventListener("error", () => addLog(`Thumb error: ${item.url}`));
            thumb.appendChild(video);
          }
        }

        const overlay = document.createElement("div");
        overlay.className = "thumb-overlay";
        const statusChip = document.createElement("div");
        statusChip.className = "thumb-status";
        const actions = document.createElement("div");
        actions.className = "thumb-actions";

        const downloadAction = document.createElement("button");
        downloadAction.type = "button";
        downloadAction.className = "icon-btn";
        downloadAction.title = "Download";
        downloadAction.textContent = "↓";
        downloadAction.dataset.action = "download";
        downloadAction.dataset.index = String(index);

        const deleteAction = document.createElement("button");
        deleteAction.type = "button";
        deleteAction.className = "icon-btn danger";
        deleteAction.title = item.postId ? "Delete" : "Delete unavailable";
        deleteAction.textContent = "✕";
        deleteAction.dataset.action = "delete";
        deleteAction.dataset.index = String(index);
        if (!item.postId || state.busy) deleteAction.disabled = true;

        actions.appendChild(downloadAction);
        actions.appendChild(deleteAction);
        overlay.appendChild(statusChip);
        overlay.appendChild(actions);
        thumb.appendChild(overlay);
        card.appendChild(thumb);
        fragment.appendChild(card);
      }
      gridEl.appendChild(fragment);
      if (index < items.length) {
        scheduleWork(renderChunk);
        return;
      }
      updateActionButtons();
    };
    scheduleWork(renderChunk);
  };

  const loadPlayer = () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    const isImages = state.mode === "images" && item.url && isImage(item.url, item.mimeType);
    if (isImages) {
      if (playerEl) {
        try {
          playerEl.pause();
        } catch (e) {}
        playerEl.removeAttribute("src");
        playerEl.load();
        playerEl.style.display = "none";
        playerEl.controls = false;
      }
      if (imageEl) {
        imageEl.style.display = "block";
        imageEl.src = item.url;
      }
    } else {
      if (imageEl) {
        imageEl.style.display = "none";
        imageEl.removeAttribute("src");
      }
      if (!playerEl) return;
      playerEl.style.display = "";
      playerEl.controls = true;
      playerEl.pause();
      playerEl.src = item.url;
      playerEl.loop = !state.autoAdvance;
      playerEl.load();
      const playPromise = playerEl.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    }
    updateCount();
    updateActionButtons();
  };

  const toggleAutoAdvance = () => {
    state.autoAdvance = !state.autoAdvance;
    if (playerEl) {
      playerEl.loop = !state.autoAdvance;
    }
    updateActionButtons();
  };

  const openLightbox = (index) => {
    if (!lightboxEl) return;
    state.selectedIndex = (index + state.items.length) % state.items.length;
    lightboxEl.classList.add("open");
    lightboxEl.setAttribute("aria-hidden", "false");
    loadPlayer();
  };

  const closeLightbox = () => {
    if (!lightboxEl) return;
    lightboxEl.classList.remove("open");
    lightboxEl.setAttribute("aria-hidden", "true");
    if (playerEl) {
      playerEl.pause();
      playerEl.removeAttribute("src");
      playerEl.load();
    }
    if (imageEl) {
      imageEl.style.display = "none";
      imageEl.removeAttribute("src");
    }
  };

  const step = (delta) => {
    if (!state.items.length) return;
    state.selectedIndex = (state.selectedIndex + delta + state.items.length) % state.items.length;
    loadPlayer();
  };

  const startLogTimer = () => {};

  const stopLogTimer = () => {};

  const toggleLogs = () => {};


  const initHideModToastToggle = () => {
    if (!hideModToastToggle) return;
    chrome.storage.local.get("gvHideModerationToast", (data) => {
      hideModToastToggle.checked = Boolean(data && data.gvHideModerationToast);
    });
  };

  const initUI = async () => {
    const response = await fetch(chrome.runtime.getURL("embed.html"));
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script").forEach((script) => script.remove());
    const style = doc.querySelector("style");
    const body = doc.body;

    const overlay = document.createElement("div");
    overlay.id = "gv-overlay";
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: #0b0f16;
      display: flex;
      justify-content: center;
      align-items: stretch;
      overflow: auto;
    `;

    const host = document.createElement("div");
    host.id = "gv-root";
    host.style.cssText = "width: 100%; max-width: 1200px;";
    overlay.appendChild(host);
    document.body.appendChild(overlay);

    const shadow = host.attachShadow({ mode: "open" });
    if (style) {
      const styleEl = document.createElement("style");
      const rawCss = style.textContent || "";
      const cssWithHost = rawCss.replace(/\bbody\b/g, ":host");
      styleEl.textContent = cssWithHost.replace(/url\((['"]?)(images\/[^'")]+)\1\)/g, (match, quote, path) => {
        const resolved = chrome.runtime.getURL(path);
        const q = quote || "";
        return `url(${q}${resolved}${q})`;
      });
      shadow.appendChild(styleEl);
    }
    const container = document.createElement("div");
    container.innerHTML = body.innerHTML;
    container.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (!src) return;
      if (src.startsWith("chrome-extension://") || src.startsWith("http") || src.startsWith("data:")) return;
      const cleaned = src.startsWith("/") ? src.slice(1) : src;
      img.src = chrome.runtime.getURL(cleaned);
    });
    shadow.appendChild(container);

    root = shadow;
    statusEl = shadow.querySelector("#status");
    gridEl = shadow.querySelector("#grid");
    emptyEl = shadow.querySelector("#empty");
    countEl = shadow.querySelector("#count");
    thumbAutoplayBtn = shadow.querySelector("#thumbAutoplayBtn");
    sortBtn = shadow.querySelector("#sortBtn");
    refreshBtn = shadow.querySelector("#refreshBtn");
    downloadAllBtn = shadow.querySelector("#downloadAllBtn");
    deleteAllBtn = shadow.querySelector("#deleteAllBtn");
    tabVideosBtn = shadow.querySelector("#tabVideos");
    tabImagesBtn = shadow.querySelector("#tabImages");
    downloadReadyEl = shadow.querySelector("#downloadReady");
    if (downloadReadyEl) {
      downloadReadyEl.onclick = () => {
        openDownloadsFolder(lastDownloadFilename);
      };
    }
    downloadReadyAudio = new Audio(chrome.runtime.getURL("audio/1.mp3"));
    logsBtn = shadow.querySelector("#logsBtn");
    logsPanel = shadow.querySelector("#logsPanel");
    logsBody = shadow.querySelector("#logsBody");
    clearLogsBtn = shadow.querySelector("#clearLogsBtn");
    purgeBtn = shadow.querySelector("#purgeBtn");
    hideModToastToggle = shadow.querySelector("#hideModToastToggle");
    logsCloseBtn = shadow.querySelector("#logsCloseBtn");
    lightboxEl = shadow.querySelector("#lightbox");
    lightboxCountEl = shadow.querySelector("#lightboxCount");
    closeBtn = shadow.querySelector("#closeBtn");
    fullscreenBtn = shadow.querySelector("#fullscreenBtn");
    downloadBtn = shadow.querySelector("#downloadBtn");
    deleteBtn = shadow.querySelector("#deleteBtn");
    autoNextBtn = shadow.querySelector("#autoNextBtn");
    prevBtn = shadow.querySelector("#prevBtn");
    nextBtn = shadow.querySelector("#nextBtn");
    playerEl = shadow.querySelector("#player");
    const playerBox = shadow.querySelector(".gv-player-box");
    if (playerBox) {
      const img = document.createElement("img");
      img.id = "imagePlayer";
      img.alt = "Generated image";
      img.style.cssText = "display:none;max-width:100%;max-height:70vh;object-fit:contain;border-radius:18px;";
      playerBox.appendChild(img);
      imageEl = img;
    }
    toastEl = shadow.querySelector("#toast");
    toastText = shadow.querySelector("#toastText");
    githubBtn = shadow.querySelector("#githubBtn");
    downloadProgressEl = shadow.querySelector("#downloadProgress");
    downloadProgressText = shadow.querySelector("#downloadProgressText");
    downloadProgressFill = shadow.querySelector("#downloadProgressFill");

    if (refreshBtn) refreshBtn.onclick = refresh;
    if (downloadAllBtn) downloadAllBtn.onclick = downloadAll;
    if (deleteAllBtn) deleteAllBtn.onclick = deleteAll;
    if (gridEl) {
      gridEl.addEventListener("click", (event) => {
        const actionBtn = event.target && event.target.closest ? event.target.closest("button.icon-btn") : null;
        if (actionBtn && gridEl.contains(actionBtn)) {
          event.preventDefault();
          event.stopPropagation();
          const index = Number(actionBtn.dataset.index || "-1");
          const item = state.items[index];
          if (!item || state.busy) return;
          const action = actionBtn.dataset.action || "";
          if (action === "download") downloadFile(item);
          if (action === "delete") deleteItem(item);
          return;
        }
        const thumbBtn = event.target && event.target.closest ? event.target.closest(".thumb") : null;
        if (thumbBtn && gridEl.contains(thumbBtn)) {
          event.preventDefault();
          const index = Number(thumbBtn.dataset.index || "-1");
          if (Number.isFinite(index) && index >= 0) openLightbox(index);
        }
      });
      gridEl.addEventListener("keydown", (event) => {
        const actionBtn = event.target && event.target.closest ? event.target.closest("button.icon-btn") : null;
        if (actionBtn && gridEl.contains(actionBtn)) return;
        const thumb = event.target && event.target.closest ? event.target.closest(".thumb") : null;
        if (!thumb || !gridEl.contains(thumb)) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const index = Number(thumb.dataset.index || "-1");
        if (Number.isFinite(index) && index >= 0) openLightbox(index);
      });
    }
    if (thumbAutoplayBtn) {
      thumbAutoplayBtn.onclick = () => {
        state.thumbAutoplay = !state.thumbAutoplay;
        if (!state.thumbAutoplay && thumbObserver) {
          try {
            thumbObserver.disconnect();
          } catch (e) {}
          thumbObserver = null;
        }
        applyModeUI();
        renderGrid();
        updateActionButtons();
      };
    }
    if (sortBtn) {
      sortBtn.onclick = () => {
        state.sortOrder = state.sortOrder === "asc" ? "desc" : "asc";
        state.items = computeCurrentItems();
        applyModeUI();
        renderGrid();
        updateCount();
        updateActionButtons();
      };
    }
    if (purgeBtn) {
      purgeBtn.onclick = () => purgeCache();
    }
    if (tabVideosBtn) tabVideosBtn.onclick = () => setMode("videos");
    if (tabImagesBtn) tabImagesBtn.onclick = () => setMode("images");
    if (hideModToastToggle) {
      hideModToastToggle.onchange = () => {
        const enabled = !!hideModToastToggle.checked;
        chrome.storage.local.set({ gvHideModerationToast: enabled });
        chrome.runtime.sendMessage({ action: "grokViewerSetHideModToast", enabled });
      };
    }
    if (downloadBtn) downloadBtn.onclick = downloadOne;
    if (deleteBtn) deleteBtn.onclick = deleteOne;
    if (autoNextBtn) autoNextBtn.onclick = toggleAutoAdvance;
    if (githubBtn) {
      githubBtn.onclick = () => {
        window.open("https://github.com/exabeet/grok-viewer", "_blank", "noopener");
      };
    }
    if (closeBtn) closeBtn.onclick = closeLightbox;
    if (fullscreenBtn) {
      fullscreenBtn.onclick = () => {
        const targetEl = state.mode === "images" ? imageEl : playerEl;
        if (!targetEl) return;
        const isFullscreen = document.fullscreenElement;
        if (isFullscreen) {
          document.exitFullscreen().catch(() => {});
          return;
        }
        if (targetEl.requestFullscreen) {
          targetEl.requestFullscreen().catch(() => {});
        }
      };
    }
    if (prevBtn) prevBtn.onclick = () => step(-1);
    if (nextBtn) nextBtn.onclick = () => step(1);
    if (playerEl) {
      playerEl.addEventListener("ended", () => {
        if (state.mode !== "images" && state.autoAdvance) step(1);
      });
    }
    if (lightboxEl) {
      lightboxEl.onclick = (event) => {
        if (event.target === lightboxEl) closeLightbox();
      };
    }

    document.addEventListener("keydown", (event) => {
      if (!lightboxEl || !lightboxEl.classList.contains("open")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "Escape") closeLightbox();
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (state.mode === "images") return;
        if (!playerEl) return;
        if (playerEl.paused) {
          const playPromise = playerEl.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {});
          }
        } else {
          playerEl.pause();
        }
      }
    });

    initHideModToastToggle();
    setStatus("Press Refresh.");
    applyModeUI();
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const cached = data && data[STORAGE_KEY] ? data[STORAGE_KEY] : null;
      const cachedItems = cached && Array.isArray(cached.items) ? cached.items : [];
      if (cachedItems.length) {
        updateItems(cachedItems, state.imageItems);
        setStatus("Ready.");
      }
      refresh();
    });
  };

  initUI();
})();
