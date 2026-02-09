(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const VIEW_MODE_KEY = "grokViewerViewMode";
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

  const createModeState = () => ({
    cursor: null,
    exhausted: false,
    pageCache: new Map(),
    pageCursors: [null],
    seen: new Set(),
    totalLoaded: 0,
    maxPageLoaded: -1
  });

  const state = {
    items: [],
    videoItems: [],
    imageItems: [],
    mode: "videos",
    viewMode: "normal",
    selectedIndex: 0,
    busy: false,
    logsOpen: false,
    lastUpdatedAt: 0,
    knownUrls: new Set(),
    autoAdvance: false,
    thumbAutoplay: false,
    sortOrder: "desc",
    renderToken: 0,
    pageSize: 38,
    pageByMode: { videos: 0, images: 0 },
    pageLoading: false,
    groupOrder: new Map(),
    groupLatest: new Map(),
    modeState: {
      videos: createModeState(),
      images: createModeState()
    }
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
            resetAllModes();
            updateItems();
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

  const buildIcon = (path, alt) => {
    const img = document.createElement("img");
    img.src = chrome.runtime.getURL(path);
    img.alt = alt || "";
    img.draggable = false;
    return img;
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

  const isGridMode = () => state.viewMode === "grid";

  const getCreatedAtValue = (post) =>
    (post &&
      (post.createTime ||
        post.createdAt ||
        post.created_at ||
        post.updateTime ||
        post.updatedAt ||
        post.updated_at ||
        post.favoritedAt ||
        post.favorited_at ||
        post.likedAt ||
        post.liked_at ||
        post.timestamp ||
        post.time ||
        "")) ||
    "";

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
      originalPostId: post.originalPostId || "",
      parentPostId: post.parentPostId || parentPostId || post.originalPostId || "",
      sourceImageUrl: normalizeUrl(parentImageUrl || ""),
      promptText: looksLikeImagePrompt ? "" : promptCandidate,
      hasPrompt,
      createdAt: getCreatedAtValue(post)
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
      originalPostId: post.originalPostId || "",
      parentPostId: post.parentPostId || post.originalPostId || "",
      createdAt: getCreatedAtValue(post),
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
      if (post && post.originalPost) {
        const original = post.originalPost;
        const originalImageUrl = original && original.mediaUrl ? original.mediaUrl : parentImageUrl;
        const originalPrompt =
          original && (original.originalPrompt || original.prompt)
            ? original.originalPrompt || original.prompt
            : parentPrompt;
        const originalImageItem = buildImageItem(original);
        if (originalImageItem) images.push(originalImageItem);
        (original.videos || []).forEach((video) => {
          const videoItem = buildItem(video, original.id || "", originalImageUrl, originalPrompt);
          if (videoItem) videos.push(videoItem);
        });
        (original.childPosts || []).forEach((child) => {
          const childItem = buildItem(child, original.id || "", originalImageUrl, originalPrompt);
          if (childItem) videos.push(childItem);
        });
      }
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

  const resolveActiveItem = (item) => {
    if (!item) return null;
    if (item.variants && item.variants.length) {
      const index = Number.isFinite(item.activeIndex) ? item.activeIndex : 0;
      return item.variants[index] || item.variants[0] || item;
    }
    return item;
  };

  const flattenGroups = (items) => {
    const flat = [];
    (items || []).forEach((item) => {
      if (item && item.variants && item.variants.length) {
        flat.push(...item.variants);
      } else if (item) {
        flat.push(item);
      }
    });
    return flat;
  };

  const getGroupKey = (item) => {
    if (!item) return "";
    return item.originalPostId || item.parentPostId || item.postId || getItemKey(item);
  };

  const groupItems = (items) => {
    const map = new Map();
    (items || []).forEach((item) => {
      if (!item) return;
      const key = getGroupKey(item);
      if (!key) return;
      const group = map.get(key) || { groupId: key, items: [] };
      group.items.push(item);
      map.set(key, group);
    });
    const groups = [];
    map.forEach((group) => {
    const direction = state.sortOrder === "asc" ? 1 : -1;
    const sorted = (group.items || []).slice().sort((a, b) => (toTime(b.createdAt) - toTime(a.createdAt)) * direction);
    const primary = sorted[0] || group.items[0];
    const latestTime = toTime(primary && primary.createdAt);
    const sortKey = direction === "asc" ? latestTime : -latestTime;
    state.groupOrder.set(group.groupId, sortKey || 0);
    state.groupLatest.set(group.groupId, latestTime);
    const grouped = {
      ...primary,
      groupId: group.groupId,
      variants: sorted,
      activeIndex: 0,
      isGroup: sorted.length > 1,
      groupCount: sorted.length,
      groupSortKey: state.groupOrder.get(group.groupId) || 0
    };
      groups.push(grouped);
    });
    return groups.sort((a, b) => (a.groupSortKey || 0) - (b.groupSortKey || 0));
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

  const prunePageCache = (mode, currentPage) => {
    const modeState = getModeState(mode);
    modeState.pageCache.forEach((value, key) => {
      if (key < currentPage - 1 || key > currentPage + 1) {
        modeState.pageCache.delete(key);
      }
    });
  };

  const fetchAndCachePage = async (mode, pageIndex) => {
    const modeState = getModeState(mode);
    const cursor = modeState.pageCursors[pageIndex] || null;
    const data = await fetchPage(cursor || undefined);
    const posts = data && data.posts ? data.posts : [];
    const extracted = extractItems(posts);
    const rawItems = mode === "images" ? extracted.images || [] : extracted.videos || [];
    const deduped = mode === "images" ? dedupeImageItems(rawItems) : dedupeItems(rawItems);
    const items = [];
    deduped.forEach((item) => {
      const minItem = mode === "images" ? minimizeImageItem(item) : minimizeVideoItem(item);
      if (!minItem) return;
      const key = mode === "images" ? getImageKey(minItem) : getItemKey(minItem);
      if (!key) return;
      if (modeState.seen.has(key)) return;
      modeState.seen.add(key);
      items.push(minItem);
    });
    modeState.pageCache.set(pageIndex, items);
    modeState.totalLoaded += items.length;
    if (pageIndex > modeState.maxPageLoaded) modeState.maxPageLoaded = pageIndex;
    const nextCursor = data && data.nextCursor ? data.nextCursor : null;
    if (nextCursor && modeState.pageCursors[pageIndex + 1] === undefined) {
      modeState.pageCursors[pageIndex + 1] = nextCursor;
    }
    if (!nextCursor) modeState.exhausted = true;
  };

  const ensurePageData = async (mode, pageIndex) => {
    if (state.pageLoading) return;
    state.pageLoading = true;
    const modeState = getModeState(mode);
    try {
      setStatus("Loading page...");
      if (!modeState.pageCache.has(pageIndex)) {
        if (modeState.pageCursors[pageIndex] !== undefined) {
          await fetchAndCachePage(mode, pageIndex);
        } else {
          while (modeState.pageCursors.length <= pageIndex && !modeState.exhausted) {
            const fetchIndex = modeState.pageCursors.length - 1;
            await fetchAndCachePage(mode, fetchIndex);
          }
          if (modeState.pageCursors[pageIndex] !== undefined && !modeState.pageCache.has(pageIndex)) {
            await fetchAndCachePage(mode, pageIndex);
          }
        }
      }
      const safePage = modeState.exhausted
        ? Math.max(0, Math.min(pageIndex, modeState.maxPageLoaded))
        : pageIndex;
      prunePageCache(mode, safePage);
      state.pageByMode[mode] = safePage;
      updateItems();
    } catch (error) {
      setStatus("Page load failed.");
    } finally {
      state.pageLoading = false;
      setStatus("Ready.");
    }
  };

  const goToLastPage = async () => {
    if (state.pageLoading) return;
    state.pageLoading = true;
    const mode = state.mode;
    const modeState = getModeState(mode);
    try {
      setStatus("Loading last page...");
      while (!modeState.exhausted) {
        const fetchIndex = modeState.pageCursors.length - 1;
        await fetchAndCachePage(mode, fetchIndex);
        prunePageCache(mode, modeState.maxPageLoaded);
      }
      const lastPage = Math.max(0, modeState.maxPageLoaded);
      prunePageCache(mode, lastPage);
      state.pageByMode[mode] = lastPage;
      updateItems();
    } catch (error) {
      setStatus("Page load failed.");
    } finally {
      state.pageLoading = false;
      setStatus("Ready.");
    }
  };

  const getModeState = (mode) => state.modeState[mode];

  const getImageKey = (item) => {
    if (!item) return "";
    if (item.postId) return `post:${item.postId}`;
    if (item.url) return `url:${stripUrlForKey(item.url)}`;
    return "";
  };

  const minimizeVideoItem = (item) =>
    item
      ? {
          id: item.id,
          url: item.url,
          poster: item.poster,
          postId: item.postId,
          createdAt: item.createdAt,
          hdMediaUrl: item.hdMediaUrl,
          mimeType: item.mimeType,
          originalPostId: item.originalPostId,
          parentPostId: item.parentPostId
        }
      : null;

  const minimizeImageItem = (item) =>
    item
      ? {
          id: item.id,
          url: item.url,
          poster: item.poster,
          postId: item.postId,
          createdAt: item.createdAt,
          mimeType: item.mimeType,
          originalPostId: item.originalPostId,
          parentPostId: item.parentPostId,
          childVideoIds: item.childVideoIds || []
        }
      : null;

  const getCachedItems = (mode) => {
    const modeState = getModeState(mode);
    const items = [];
    Array.from(modeState.pageCache.keys())
      .sort((a, b) => a - b)
      .forEach((key) => {
        const pageItems = modeState.pageCache.get(key) || [];
        items.push(...pageItems);
      });
    return items;
  };

  const resetModeState = (mode) => {
    const modeState = getModeState(mode);
    modeState.cursor = null;
    modeState.exhausted = false;
    modeState.pageCache.clear();
    modeState.pageCursors = [null];
    modeState.seen = new Set();
    modeState.totalLoaded = 0;
    modeState.maxPageLoaded = -1;
    state.pageByMode[mode] = 0;
  };

  const resetAllModes = () => {
    resetModeState("videos");
    resetModeState("images");
    state.items = [];
    state.videoItems = [];
    state.imageItems = [];
    state.groupOrder = new Map();
    state.groupLatest = new Map();
  };

  const toTime = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return 0;
      const num = Number(trimmed);
      if (Number.isFinite(num)) return num < 1e12 ? num * 1000 : num;
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const sortByCreatedAt = (items) => {
    const direction = state.sortOrder === "asc" ? 1 : -1;
    return (items || [])
      .slice()
      .sort((a, b) => (toTime(a.createdAt) - toTime(b.createdAt)) * direction);
  };

  const computeCurrentItems = () => {
    const modeState = getModeState(state.mode);
    const page = clampPage(state.mode);
    const items = modeState.pageCache.get(page) || [];
    const sorted = sortByCreatedAt(items);
    return isGridMode() ? groupItems(sorted) : sorted;
  };

  const getPageCount = (mode) => {
    const modeState = getModeState(mode);
    const base = Math.max(1, modeState.maxPageLoaded + 1);
    if (modeState.maxPageLoaded < 0) return 1;
    if (modeState.exhausted) return base;
    return base + 1;
  };

  const clampPage = (mode) => {
    const current = state.pageByMode[mode] || 0;
    let next = Math.max(0, current);
    if (getModeState(mode).exhausted) {
      const pageCount = getPageCount(mode);
      next = Math.min(pageCount - 1, next);
    }
    state.pageByMode[mode] = next;
    return next;
  };

  const updatePager = () => {
    if (!prevPageBtn || !nextPageBtn || !pageInfoEl) return;
    const pageCount = getPageCount(state.mode);
    const page = clampPage(state.mode);
    const modeState = getModeState(state.mode);
    prevPageBtn.disabled = page <= 0;
    if (firstPageBtn) firstPageBtn.disabled = page <= 0;
    nextPageBtn.disabled = page >= pageCount - 1;
    if (lastPageBtn) lastPageBtn.disabled = pageCount <= 1 || (modeState.exhausted && page >= pageCount - 1);
    pageInfoEl.textContent = `Page ${page + 1} / ${pageCount}`;
    if (pageJumpBtn) pageJumpBtn.disabled = pageCount <= 1;
    if (downloadAllBtn) downloadAllBtn.textContent = "Download All";
  };

  const updateItems = () => {
    state.videoItems = getCachedItems("videos");
    state.imageItems = getCachedItems("images");
    clampPage("videos");
    clampPage("images");
    state.items = computeCurrentItems();
    state.lastUpdatedAt = Date.now();
    renderGrid();
    updateCount();
    updatePager();
  };

  const refresh = async () => {
    if (state.busy) return;
    state.busy = true;
    setStatus("Refreshing favorites...");
    addLog("Refresh requested");
    try {
      await ensureUserScope();
      resetAllModes();
      await ensurePageData(state.mode, 0);
      chrome.storage.local.set({ [STORAGE_KEY]: { items: state.videoItems, updatedAt: Date.now() } }, () => {});
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
    const targetItem = resolveActiveItem(item);
    if (!targetItem || !targetItem.postId || state.busy) return;
    state.busy = true;
    const isImages = state.mode === "images" && targetItem.url && isImage(targetItem.url, targetItem.mimeType);
    const isGridDelete = isGridMode() && !isImages;
    setStatus(isImages ? "Deleting image..." : "Deleting video...");
    setThumbStatus(targetItem.postId, "deleting", "Deleting...");
    if (isImages) {
      const childIds = Array.from(new Set((targetItem.childVideoIds || []).filter(Boolean)));
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
    const result = await deletePost(targetItem.postId);
    state.busy = false;
    if (!result.ok) {
      setStatus("Delete failed.");
      showToast("Delete failed.", "error");
      setThumbStatus(item.postId, "failed", "Failed");
      updateActionButtons();
      return;
    }
    let remainingVariants = null;
    if (isGridDelete) {
      const group = state.items.find(
        (entry) => entry && entry.variants && entry.variants.some((variant) => variant && variant.postId === targetItem.postId)
      );
      if (group && group.variants) {
        remainingVariants = group.variants.filter((variant) => variant && variant.postId !== targetItem.postId);
      }
    }
    const modeState = getModeState(state.mode);
    modeState.pageCache.forEach((pageItems, key) => {
      const filtered = (pageItems || []).filter((entry) => entry.postId !== targetItem.postId);
      modeState.pageCache.set(key, filtered);
    });
    if (isGridDelete && remainingVariants && remainingVariants.length) {
      const page = state.pageByMode[state.mode] || 0;
      const pageItems = modeState.pageCache.get(page) || [];
      const existing = new Set(pageItems.map((entry) => entry && entry.postId).filter(Boolean));
      remainingVariants.forEach((variant) => {
        if (!variant || !variant.postId || existing.has(variant.postId)) return;
        pageItems.push(variant);
        existing.add(variant.postId);
      });
      modeState.pageCache.set(page, pageItems);
    }
    if (modeState.totalLoaded > 0) modeState.totalLoaded -= 1;
    let variantRemoveDelay = 0;
    if (variantStripEl && targetItem.postId) {
      const variantThumb = variantStripEl.querySelector(`.variant-thumb[data-variant-id="${targetItem.postId}"]`);
      if (variantThumb) {
        variantThumb.classList.add("removing");
        variantRemoveDelay = 180;
      }
    }
    if (variantRemoveDelay) {
      setTimeout(() => updateItems(), variantRemoveDelay);
    } else {
      updateItems();
    }
    setStatus(isImages ? "Image deleted." : "Video deleted.");
    updateActionButtons();
    if (!isImages && !isGridDelete) {
      setTimeout(() => {
        purgeCache({ confirm: false, reload: true, silent: true });
      }, 900);
    }
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
      const totalIds = new Set();
      let deletedCount = 0;
      showDeleteProgress("Deleting images 0/0", 0);
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
        images.forEach((item) => {
          if (item && item.postId) totalIds.add(item.postId);
        });
        const totalCount = Math.max(1, totalIds.size);
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
            hideDownloadProgress(0);
            updateActionButtons();
            return;
          }
          await sleep(140);
        }
        const toDelete = images.map((item) => item.postId);
        failed = [];
        for (let i = 0; i < toDelete.length; i += 1) {
          const res = await deletePost(toDelete[i]);
          if (!res.ok) failed.push(toDelete[i]);
          deletedCount += 1;
          const totalCount = Math.max(1, totalIds.size);
          showDeleteProgress(`Deleting images ${deletedCount}/${totalCount}`, deletedCount / totalCount);
          await sleep(180);
        }
        cycle += 1;
        if (failed.length === toDelete.length) break;
        await sleep(350);
      }
      if (last) {
        updateItems();
      }
      state.busy = false;
      setStatus(failed.length ? `Failed ${failed.length} deletions.` : "All deletions requested.");
      if (failed.length) {
        showToast("Some deletions failed.", "error");
        hideDownloadProgress(0);
      } else {
        showDeleteDone("All your images have been removed");
      }
      failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
      if (!failed.length) {
        setStatus("Purging cache...");
        setTimeout(() => {
          purgeCache({ confirm: false, reload: true, silent: true });
        }, 2100);
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
    const totalIds = new Set();
    let deletedCount = 0;
    showDeleteProgress("Deleting videos 0/0", 0);
    const failed = [];
    const seen = new Set();
    let cursor = undefined;
    let safety = 0;
    while (true) {
      const data = await fetchPage(cursor);
      const posts = data && data.posts ? data.posts : [];
      const extracted = extractItems(posts);
      const videos = dedupeItems(extracted.videos || []);
      for (let i = 0; i < videos.length; i += 1) {
        const id = videos[i] && videos[i].postId ? videos[i].postId : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        totalIds.add(id);
        setThumbStatus(id, "deleting", "Deleting...");
        const result = await deletePost(id);
        if (!result.ok) failed.push(id);
        deletedCount += 1;
        const totalCount = Math.max(1, totalIds.size);
        showDeleteProgress(`Deleting videos ${deletedCount}/${totalCount}`, deletedCount / totalCount);
        await sleep(180);
      }
      const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
      if (!nextCursor) break;
      cursor = nextCursor;
      safety += 1;
      if (safety > 200) break;
    }
    resetModeState("videos");
    await ensurePageData("videos", 0);
    state.busy = false;
    setStatus(failed.length ? `Failed ${failed.length} deletions.` : "All deletions requested.");
    if (failed.length) {
      showToast("Some deletions failed.", "error");
      hideDownloadProgress(0);
    } else {
      showDeleteDone("All your videos have been removed");
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

  const downloadViaExtension = (url, filename, saveAs) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "grokViewerDownloadUrl", url, filename, saveAs: !!saveAs },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false });
        }
      );
    });

  const isDownloadCanceled = (result) => {
    const err = result && result.error ? String(result.error).toLowerCase() : "";
    return err.includes("canceled") || err.includes("cancelled") || err.includes("user_canceled");
  };

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read-error"));
      reader.readAsDataURL(blob);
    });

  const downloadBlobViaExtension = async (blob, filename) => {
    const blobUrl = URL.createObjectURL(blob);
    const result = await downloadViaExtension(blobUrl, filename, true);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return result;
  };

  const downloadFile = async (item) => {
    const targetItem = resolveActiveItem(item);
    if (!targetItem) return;
    const targetUrl = pickDownloadUrl(targetItem);
    const isImg = isImage(targetUrl, targetItem.mimeType);
    const baseUrl = (targetUrl || "").split(/[?#]/)[0];
    const extMatch = baseUrl.match(/\.([a-z0-9]{2,6})$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : "bin";
    const filenameBase = targetItem.postId || targetItem.id || "grok-media";
    const filename = `${filenameBase}.${ext}`;
    const started = await downloadViaExtension(targetUrl, filename, true);
    if (!started || !started.ok) {
      if (isDownloadCanceled(started)) {
        setReadyStatus();
        return;
      }
      setStatus("Download failed.");
      return;
    }
    showDownloadReady("Your file is ready. Click here", filename);
    await waitForDownloadWithTimeout(filename, true, 20000);
  };

  const downloadOne = () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    downloadFile(item);
  };

  const downloadGroup = () => {
    const group = state.items[state.selectedIndex];
    if (!group || !group.variants || group.variants.length <= 1 || state.busy) return;
    const isImages = state.mode === "images";
    state.busy = true;
    updateActionButtons();
    setStatus("Preparing compilation...");
    showDownloadProgress();
    if (downloadGroupBtn) {
      downloadGroupBtn.classList.add("done");
      downloadGroupBtn.textContent = "File downloaded!";
      setTimeout(() => {
        if (!downloadGroupBtn) return;
        downloadGroupBtn.classList.remove("done");
        downloadGroupBtn.textContent = "Download only this compilation";
      }, 5000);
    }
    const run = async () => {
      try {
        const items = group.variants.slice();
        const files = [];
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (!item) continue;
          const targetUrl = item.hdMediaUrl || item.url;
          const response = await fetchWithTimeout(targetUrl, 60000);
          if (!response || !response.ok) continue;
          const buffer = new Uint8Array(await response.arrayBuffer());
          const { dosTime, dosDate } = toDosTimeDate(new Date());
          const baseUrl = (item.url || "").split(/[?#]/)[0];
          const extMatch = baseUrl.match(/\\.([a-z0-9]{2,6})$/i);
          const ext = extMatch ? extMatch[1].toLowerCase() : isImages ? "jpg" : "mp4";
          const name = `${item.postId || item.id}.${ext}`;
          files.push({
            name,
            data: buffer,
            size: buffer.length,
            crc: crc32(buffer),
            dosTime,
            dosDate
          });
          const prepText = `Preparing compilation ${i + 1}/${items.length}...`;
          setStatus(prepText);
          setDownloadProgress(prepText, (i + 1) / items.length);
          await sleep(80);
        }
        if (!files.length) {
          setStatus("Download failed.");
          return;
        }
        const blob = buildZipBlob(files);
        const archiveName = `grok-compilation-${Date.now()}.zip`;
        const started = await downloadBlobViaExtension(blob, archiveName);
        if (!started || !started.ok) {
          if (isDownloadCanceled(started)) {
            hideDownloadProgress(0);
            if (githubBtn) githubBtn.classList.remove("hidden");
            setReadyStatus();
            return;
          }
          setStatus("Download failed.");
          return;
        }
        const startText = "Starting download of archive 1...";
        setStatus(startText);
        setDownloadProgress(startText, 0);
        showDownloadReady("Your file is ready. Click here", archiveName);
        await waitForDownloadWithTimeout(archiveName, true, 20000);
      } catch (error) {
        setStatus("Download failed.");
      } finally {
        state.busy = false;
        hideDownloadProgress(0);
        updateActionButtons();
      }
    };
    run();
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
    const pageCount = getPageCount(state.mode);
    const page = clampPage(state.mode);
    const pageItems = (isGridMode() ? flattenGroups(state.items) : state.items).slice();
    const initialPageLabel = pageCount > 1 ? `page ${page + 1}/${pageCount}` : "page 1/1";
    setStatus(`Preparing archive for ${initialPageLabel}...`);
    showDownloadProgress();
    const run = async () => {
      try {
        const total = pageItems.length;
        const batchSize = total > 80 ? 15 : total > 45 ? 25 : total;
        const batches = [];
        for (let i = 0; i < total; i += batchSize) {
          batches.push(pageItems.slice(i, i + batchSize));
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
                const pageLabel = pageCount > 1 ? `page ${page + 1}/${pageCount}` : "page 1/1";
                setStatus(`Preparing archive for ${pageLabel}...`);
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
              const pageLabel = pageCount > 1 ? `page ${page + 1}/${pageCount}` : "page 1/1";
              const prepText = `Preparing archive for ${pageLabel}...`;
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
          const pageLabel = pageCount > 1 ? `page ${page + 1}/${pageCount}` : "page 1/1";
          const buildText = `Preparing archive for ${pageLabel}...`;
          setStatus(buildText);
          setDownloadProgress(buildText, 1);
          const blob = buildZipBlob(files);
          const prefix = isImages ? "grok-images" : "grok-videos";
          const archiveName =
            batches.length > 1
              ? `${prefix}-${baseTime}-part-${batchIndex + 1}.zip`
              : `${prefix}-${baseTime}.zip`;
          const started = await downloadBlobViaExtension(blob, archiveName);
          if (!started || !started.ok) {
            const err = (started && started.error ? String(started.error) : "").toLowerCase();
            if (err.includes("canceled") || err.includes("cancelled") || err.includes("user_canceled")) {
              hideDownloadProgress(0);
              if (githubBtn) githubBtn.classList.remove("hidden");
              setReadyStatus();
              break;
            }
            setStatus("Download failed.");
            break;
          }
          const startText = `Starting download of archive ${batchIndex + 1}...`;
          setStatus(startText);
          setDownloadProgress(startText, 0);
          showDownloadReady("Your file is ready. Click here", archiveName);
          await waitForDownloadWithTimeout(archiveName, true, 20000);
          await sleep(350);
        }
        setReadyStatus();
      } catch (error) {
        setStatus("Download all failed.");
      } finally {
        state.busy = false;
        hideDownloadProgress(0);
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
  let footerEl;
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
  let deleteDoneEl;
  let deleteDoneTimer = null;
  let changelogModal;
  let changelogClose;
  let changelogGithub;
  let viewModeModal;
  let modeGridBtn;
  let modeNormalBtn;
  let appEl;
  let brandTitleEl;
  let viewModeBtn;
  let viewModeIcon;
  let lastDownloadFilename = "";
  let prevPageBtn;
  let nextPageBtn;
  let pageInfoEl;
  let lastPageBtn;
  let firstPageBtn;
  let pageJumpBtn;
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
  let shareBtn;
  let deleteBtn;
  let autoNextBtn;
  let downloadGroupBtn;
  let prevBtn;
  let nextBtn;
  let playerEl;
  let variantWrapEl;
  let variantStripEl;
  let variantMoreBtn;
  let imageEl;
  let toastEl;
  let toastText;
  let hideModToastWrap;

  const updateCount = () => {
    const modeState = getModeState(state.mode);
    const total = modeState.totalLoaded || state.items.length;
    if (countEl) {
      const label = state.mode === "images" ? "image" : "video";
      countEl.textContent = `Loaded ${total} ${label}${total === 1 ? "" : "s"}`;
    }
    if (statusEl) {
      const current = (statusEl.textContent || "").trim();
      if (!current || /^Ready\\b/i.test(current) || /^Press Refresh\\b/i.test(current)) {
        statusEl.textContent = getReadyStatus();
      }
    }
    if (lightboxCountEl) {
      const pageTotal = state.items.length;
      const current = pageTotal ? state.selectedIndex + 1 : 0;
      lightboxCountEl.textContent = `${current} / ${pageTotal}`;
    }
  };

  const getReadyStatus = () => {
    const modeState = getModeState(state.mode);
    const total = modeState.totalLoaded || state.items.length;
    const label = state.mode === "images" ? "images" : "videos";
    return `Ready. Loaded ${total} ${label}`;
  };

  const setReadyStatus = () => {
    if (statusEl) statusEl.textContent = getReadyStatus();
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
    setStatus("File ready!");
    setDownloadProgress("File ready!", 1);
    if (downloadProgressEl) downloadProgressEl.classList.remove("show");
    if (githubBtn) githubBtn.classList.remove("hidden");
    if (downloadReadyTimer) clearTimeout(downloadReadyTimer);
    downloadReadyTimer = setTimeout(() => {
      downloadReadyEl.style.display = "none";
      if (githubBtn) githubBtn.classList.remove("hidden");
      setReadyStatus();
    }, 5000);
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

  const waitForDownloadWithTimeout = async (filename, requireComplete, timeoutMs) => {
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : 45000;
    const result = await Promise.race([
      waitForDownload(filename, requireComplete),
      sleep(limit).then(() => ({ ok: false, timeout: true }))
    ]);
    return result || { ok: false };
  };

  let downloadProgressTimer = null;
  const showDownloadProgress = () => {
    if (downloadProgressTimer) clearTimeout(downloadProgressTimer);
    if (downloadProgressEl) downloadProgressEl.classList.add("show");
    if (githubBtn) githubBtn.classList.add("hidden");
    if (deleteDoneEl) deleteDoneEl.classList.remove("show");
  };

  const showDeleteProgress = (text, ratio) => {
    showDownloadProgress();
    setDownloadProgress(text, ratio);
  };

  const hideDownloadProgress = (delayMs) => {
    if (downloadProgressTimer) clearTimeout(downloadProgressTimer);
    const run = () => {
      if (downloadProgressEl) downloadProgressEl.classList.remove("show");
      const readyVisible = downloadReadyEl && downloadReadyEl.style.display === "inline-flex";
      if (githubBtn && !readyVisible) githubBtn.classList.remove("hidden");
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

  const showDeleteDone = (message) => {
    if (downloadProgressEl) downloadProgressEl.classList.add("pulse");
    if (deleteDoneTimer) clearTimeout(deleteDoneTimer);
    deleteDoneTimer = setTimeout(() => {
      if (downloadProgressEl) downloadProgressEl.classList.remove("show");
      if (downloadProgressEl) downloadProgressEl.classList.remove("pulse");
      if (downloadProgressFill) downloadProgressFill.style.width = "0%";
      if (deleteDoneEl) {
        deleteDoneEl.textContent = message;
        deleteDoneEl.classList.add("show");
      }
      if (githubBtn) githubBtn.classList.add("hidden");
      deleteDoneTimer = setTimeout(() => {
        if (deleteDoneEl) deleteDoneEl.classList.remove("show");
        if (githubBtn) githubBtn.classList.remove("hidden");
      }, 2000);
    }, 400);
  };

  let toastTimer = null;
  const showToast = (message, type) => {
    if (!toastEl || !toastText) return;
    toastText.textContent = message;
    toastEl.classList.remove("hide", "error");
    if (type === "error") toastEl.classList.add("error");
    toastEl.classList.add("show");
    if (githubBtn) githubBtn.classList.add("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      toastEl.classList.add("hide");
      const progressVisible = downloadProgressEl && downloadProgressEl.classList.contains("show");
      const doneVisible = deleteDoneEl && deleteDoneEl.classList.contains("show");
      if (githubBtn && !progressVisible && !doneVisible) githubBtn.classList.remove("hidden");
    }, 1600);
  };

  const openChangelogModal = () => {
    if (!changelogModal) return;
    changelogModal.classList.add("open");
    changelogModal.setAttribute("aria-hidden", "false");
  };

  const closeChangelogModal = () => {
    if (!changelogModal) return;
    changelogModal.classList.remove("open");
    changelogModal.setAttribute("aria-hidden", "true");
  };

  const showViewModeModal = () => {
    if (!viewModeModal) return;
    viewModeModal.classList.add("open");
    viewModeModal.setAttribute("aria-hidden", "false");
    if (appEl) appEl.classList.add("hidden");
  };

  const hideViewModeModal = () => {
    if (!viewModeModal) return;
    viewModeModal.classList.remove("open");
    viewModeModal.setAttribute("aria-hidden", "true");
    if (appEl) appEl.classList.remove("hidden");
  };

  const setViewMode = (mode, persist) => {
    if (mode !== "grid" && mode !== "normal") return;
    state.viewMode = mode;
    if (persist) chrome.storage.local.set({ [VIEW_MODE_KEY]: mode });
    if (brandTitleEl) {
      brandTitleEl.textContent = mode === "grid" ? "Grok-Viewer Grid" : "Grok-Viewer";
    }
    if (viewModeIcon) {
      const icon = mode === "grid" ? "images/grid.svg" : "images/normal.svg";
      const alt = mode === "grid" ? "Grid view" : "Normal view";
      viewModeIcon.src = chrome.runtime.getURL(icon);
      viewModeIcon.alt = alt;
    }
    if (viewModeBtn) {
      viewModeBtn.dataset.tooltip = mode === "grid" ? "Return to normal mode" : "Return to Grid mode";
    }
    updateItems();
  };

  const buildShareLink = (postId) => {
    if (!postId) return "";
    return `https://grok.com/imagine/post/${postId}?source=post-page&platform=web`;
  };

  const copyToClipboard = async (text) => {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (e) {
      return false;
    }
  };

  const shareItem = async (item) => {
    const targetItem = resolveActiveItem(item);
    if (!targetItem || !targetItem.postId) return;
    const link = buildShareLink(targetItem.postId);
    if (!link) return;
    await copyToClipboard(link);
    showToast("Link copied");
  };

  const applyModeUI = () => {
    const isImages = state.mode === "images";
    if (tabVideosBtn) tabVideosBtn.classList.toggle("active", !isImages);
    if (tabImagesBtn) tabImagesBtn.classList.toggle("active", isImages);
    if (autoNextBtn) autoNextBtn.style.display = isImages ? "none" : "";
    if (downloadAllBtn) downloadAllBtn.textContent = "Download Page";
    if (deleteAllBtn) deleteAllBtn.textContent = "Delete All";
    if (downloadAllBtn) {
      downloadAllBtn.dataset.tooltip = isImages
        ? "Download all your images."
        : "Download all your videos.";
    }
    if (deleteAllBtn) {
      deleteAllBtn.dataset.tooltip = isImages ? "Delete all your images." : "Delete all your videos.";
    }
    if (refreshBtn) {
      refreshBtn.dataset.tooltip = isImages ? "Refresh images." : "Refresh videos.";
    }
    if (thumbAutoplayBtn) {
      thumbAutoplayBtn.style.display = isImages ? "none" : "";
      thumbAutoplayBtn.textContent = "Autoplay Previews";
    }
    if (sortBtn) {
      sortBtn.style.display = "";
      sortBtn.textContent = state.sortOrder === "asc" ? "Sort by old" : "Sort by new";
    }
    if (hideModToastWrap) hideModToastWrap.style.display = isImages ? "none" : "";
    if (footerEl) footerEl.style.display = "grid";
  };

  const setMode = (mode) => {
    if (mode !== "videos" && mode !== "images") return;
    if (state.mode === mode) return;
    state.mode = mode;
    state.selectedIndex = 0;
    applyModeUI();
    ensurePageData(mode, state.pageByMode[mode] || 0);
  };

  const updateActionButtons = () => {
    const selected = state.items[state.selectedIndex];
    const activeItem = resolveActiveItem(selected);
    const canDelete = Boolean(activeItem && activeItem.postId);
    const isImages = state.mode === "images";
    if (downloadBtn) downloadBtn.disabled = !activeItem || state.busy;
    if (shareBtn) shareBtn.disabled = !activeItem || !activeItem.postId || state.busy;
    if (deleteBtn) deleteBtn.disabled = !canDelete || state.busy;
    if (downloadAllBtn) {
      const hasItems = isImages ? state.imageItems.length : state.videoItems.length;
      downloadAllBtn.disabled = !hasItems || state.busy;
    }
    if (deleteAllBtn) deleteAllBtn.disabled = isImages ? !state.imageItems.length || state.busy : !state.videoItems.length || state.busy;
    if (autoNextBtn) autoNextBtn.classList.toggle("active", !isImages && state.autoAdvance);
    if (downloadGroupBtn) {
      const showGroup = isGridMode() && selected && selected.variants && selected.variants.length > 1;
      downloadGroupBtn.style.display = showGroup ? "inline-flex" : "none";
      downloadGroupBtn.disabled = !showGroup || state.busy;
    }
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
    updatePager();
    const chunkSize = 48;
    let index = 0;
    const renderChunk = () => {
      if (token !== state.renderToken) return;
      const fragment = document.createDocumentFragment();
      const sliceEnd = Math.min(index + chunkSize, items.length);
      for (; index < sliceEnd; index += 1) {
        const item = items[index];
        const displayItem = resolveActiveItem(item) || item;
        const card = document.createElement("div");
        card.className = "thumb-card";
        card.dataset.index = String(index);
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.dataset.index = String(index);
        if (displayItem && displayItem.postId) thumb.dataset.postId = displayItem.postId;
        thumb.setAttribute("role", "button");
        thumb.tabIndex = 0;

        if (mode === "images") {
          const img = document.createElement("img");
          img.src = displayItem.url;
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
          if (displayItem.poster) video.poster = displayItem.poster;
          video.dataset.src = displayItem.url;
          video.addEventListener("error", () => addLog(`Thumb error: ${displayItem.url}`));
          thumb.appendChild(video);
          ensureThumbObserver().observe(video);
        } else {
          const img = document.createElement("img");
          if (displayItem.poster) {
            img.src = displayItem.poster;
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
              video.src = displayItem.url;
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
              video.addEventListener("error", () => addLog(`Thumb error: ${displayItem.url}`));
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
            video.src = displayItem.url;
            video.addEventListener("loadeddata", () => {
              try {
                video.pause();
              } catch (e) {}
            });
            video.addEventListener("error", () => addLog(`Thumb error: ${displayItem.url}`));
            thumb.appendChild(video);
          }
        }

        if (item && item.variants && item.variants.length > 1) {
          const badge = document.createElement("div");
          badge.className = "group-badge";
          thumb.appendChild(badge);
        }

        const overlay = document.createElement("div");
        overlay.className = "thumb-overlay";
        const statusChip = document.createElement("div");
        statusChip.className = "thumb-status";
        const actions = document.createElement("div");
        actions.className = "thumb-actions";

        const downloadAction = document.createElement("button");
        downloadAction.type = "button";
        downloadAction.className = "icon-btn download";
        downloadAction.title = "Download";
        downloadAction.dataset.tooltip = "Download";
        downloadAction.appendChild(buildIcon("images/download.svg", "Download"));
        downloadAction.dataset.action = "download";
        downloadAction.dataset.index = String(index);

        const shareAction = document.createElement("button");
        shareAction.type = "button";
        shareAction.className = "icon-btn share";
        shareAction.title = displayItem.postId ? "Share" : "Share unavailable";
        shareAction.dataset.tooltip = "Share";
        shareAction.appendChild(buildIcon("images/share.svg", "Share"));
        shareAction.dataset.action = "share";
        shareAction.dataset.index = String(index);
        if (!displayItem.postId || state.busy) shareAction.disabled = true;

        const deleteAction = document.createElement("button");
        deleteAction.type = "button";
        deleteAction.className = "icon-btn danger";
        deleteAction.title = displayItem.postId ? "Delete" : "Delete unavailable";
        deleteAction.dataset.tooltip = "Delete";
        deleteAction.appendChild(buildIcon("images/close.svg", "Delete"));
        deleteAction.dataset.action = "delete";
        deleteAction.dataset.index = String(index);
        if (!displayItem.postId || state.busy) deleteAction.disabled = true;

        actions.appendChild(downloadAction);
        actions.appendChild(shareAction);
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

  const renderVariantStrip = () => {
    if (!variantStripEl || !variantWrapEl) return;
    const group = state.items[state.selectedIndex];
    if (!isGridMode() || !group || !group.variants || group.variants.length <= 1) {
      variantWrapEl.classList.remove("show");
      variantStripEl.innerHTML = "";
      if (variantMoreBtn) variantMoreBtn.style.display = "none";
      return;
    }
    variantWrapEl.classList.add("show");
    variantStripEl.innerHTML = "";
    const ordered = group.variants
      .map((variant, index) => ({ variant, index }))
      .sort((a, b) => {
        const aTime = toTime(a.variant && a.variant.createdAt);
        const bTime = toTime(b.variant && b.variant.createdAt);
        return aTime - bTime;
      });
    const parentIndex = ordered.findIndex((entry) => entry.variant && entry.variant.postId === group.groupId);
    if (parentIndex > 0) {
      const parentEntry = ordered.splice(parentIndex, 1)[0];
      ordered.unshift(parentEntry);
    }
    ordered.forEach((entry, displayIdx) => {
      const variant = entry.variant;
      const idx = entry.index;
      const thumb = document.createElement("div");
      thumb.className = "variant-thumb";
      if (idx === (group.activeIndex || 0)) thumb.classList.add("active");
      if (variant && variant.postId) thumb.dataset.variantId = variant.postId;
      const preview = variant.poster || variant.url;
      if (isMp4(preview, variant.mimeType)) {
        const vid = document.createElement("video");
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = "metadata";
        vid.src = preview;
        thumb.appendChild(vid);
      } else {
        const img = document.createElement("img");
        img.src = preview;
        img.alt = "Variant";
        thumb.appendChild(img);
      }
      const num = document.createElement("div");
      num.className = "variant-num";
      num.textContent = String(displayIdx + 1);
      thumb.appendChild(num);
      thumb.onclick = () => {
        group.activeIndex = idx;
        loadPlayer();
        renderVariantStrip();
      };
      variantStripEl.appendChild(thumb);
    });
    const isScrollable = ordered.length > 3;
    variantStripEl.classList.toggle("scrollable", isScrollable);
    if (variantMoreBtn) variantMoreBtn.style.display = isScrollable ? "grid" : "none";
    const activeThumb = variantStripEl.querySelector(".variant-thumb.active");
    if (activeThumb && typeof activeThumb.scrollIntoView === "function") {
      activeThumb.scrollIntoView({ block: "nearest" });
    }
  };

  const loadPlayer = () => {
    const group = state.items[state.selectedIndex];
    if (!group) return;
    if (group && group.variants && group.variants.length) {
      if (!Number.isFinite(group.activeIndex) || group.activeIndex >= group.variants.length) {
        group.activeIndex = 0;
      }
    }
    const item = resolveActiveItem(group);
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
    renderVariantStrip();
  };

  const toggleAutoAdvance = () => {
    state.autoAdvance = !state.autoAdvance;
    if (playerEl) {
      playerEl.loop = !state.autoAdvance;
    }
    updateActionButtons();
  };

  const stepVariant = (delta) => {
    if (!isGridMode()) return;
    const group = state.items[state.selectedIndex];
    if (!group || !group.variants || group.variants.length <= 1) return;
    const total = group.variants.length;
    const current = Number.isFinite(group.activeIndex) ? group.activeIndex : 0;
    const next = (current + delta + total) % total;
    group.activeIndex = next;
    loadPlayer();
    renderVariantStrip();
  };

  const openLightbox = (index) => {
    if (!lightboxEl) return;
    state.selectedIndex = (index + state.items.length) % state.items.length;
    const group = state.items[state.selectedIndex];
    if (group && group.variants && !Number.isFinite(group.activeIndex)) {
      group.activeIndex = 0;
    }
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
      const enabled = Boolean(data && data.gvHideModerationToast);
      hideModToastToggle.classList.toggle("active", enabled);
      hideModToastToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
      hideModToastToggle.textContent = enabled ? "Toast hidden" : "Hide moderation toast";
    });
  };

const initHideModToastTooltip = () => {};

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
      overflow: hidden;
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
    appEl = shadow.querySelector(".app");
    footerEl = shadow.querySelector(".footer");
    brandTitleEl = shadow.querySelector("#brandTitleText");
    viewModeBtn = shadow.querySelector("#viewModeBtn");
    viewModeIcon = shadow.querySelector("#viewModeIcon");
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
    prevPageBtn = shadow.querySelector("#prevPageBtn");
    nextPageBtn = shadow.querySelector("#nextPageBtn");
    pageInfoEl = shadow.querySelector("#pageInfo");
    lastPageBtn = shadow.querySelector("#lastPageBtn");
    firstPageBtn = shadow.querySelector("#firstPageBtn");
    pageJumpBtn = shadow.querySelector("#pageJumpBtn");
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
    hideModToastToggle = shadow.querySelector("#hideModToastWrap");
    hideModToastWrap = hideModToastToggle;
    logsCloseBtn = shadow.querySelector("#logsCloseBtn");
    lightboxEl = shadow.querySelector("#lightbox");
    lightboxCountEl = shadow.querySelector("#lightboxCount");
    closeBtn = shadow.querySelector("#closeBtn");
    fullscreenBtn = shadow.querySelector("#fullscreenBtn");
    downloadBtn = shadow.querySelector("#downloadBtn");
    shareBtn = shadow.querySelector("#shareBtn");
    deleteBtn = shadow.querySelector("#deleteBtn");
    autoNextBtn = shadow.querySelector("#autoNextBtn");
    downloadGroupBtn = shadow.querySelector("#downloadGroupBtn");
    prevBtn = shadow.querySelector("#prevBtn");
    nextBtn = shadow.querySelector("#nextBtn");
    playerEl = shadow.querySelector("#player");
    variantWrapEl = shadow.querySelector("#variantWrap");
    variantStripEl = shadow.querySelector("#variantStrip");
    variantMoreBtn = shadow.querySelector("#variantMoreBtn");
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
    changelogModal = shadow.querySelector("#changelogModal");
    changelogClose = shadow.querySelector("#changelogClose");
    changelogGithub = shadow.querySelector("#changelogGithub");
    viewModeModal = shadow.querySelector("#viewModeModal");
    modeGridBtn = shadow.querySelector("#modeGridBtn");
    modeNormalBtn = shadow.querySelector("#modeNormalBtn");
    downloadProgressEl = shadow.querySelector("#downloadProgress");
    downloadProgressText = shadow.querySelector("#downloadProgressText");
    downloadProgressFill = shadow.querySelector("#downloadProgressFill");
    deleteDoneEl = shadow.querySelector("#deleteDone");

    if (refreshBtn) refreshBtn.onclick = refresh;
    if (downloadAllBtn) downloadAllBtn.onclick = downloadAll;
    if (deleteAllBtn) deleteAllBtn.onclick = deleteAll;
    if (downloadGroupBtn) downloadGroupBtn.onclick = downloadGroup;
    if (prevPageBtn) {
      prevPageBtn.onclick = () => {
        const mode = state.mode;
        const current = state.pageByMode[mode] || 0;
        const next = Math.max(0, current - 1);
        state.pageByMode[mode] = next;
        ensurePageData(mode, next);
      };
    }
    if (firstPageBtn) {
      firstPageBtn.onclick = () => {
        const mode = state.mode;
        state.pageByMode[mode] = 0;
        ensurePageData(mode, 0);
      };
    }
    if (nextPageBtn) {
      nextPageBtn.onclick = () => {
        const mode = state.mode;
        const current = state.pageByMode[mode] || 0;
        const next = current + 1;
        state.pageByMode[mode] = next;
        ensurePageData(mode, next);
      };
    }
    if (lastPageBtn) {
      lastPageBtn.onclick = () => {
        goToLastPage();
      };
    }
    if (pageJumpBtn) {
      pageJumpBtn.onclick = () => {
        const pageCount = getPageCount(state.mode);
        const value = window.prompt(`Go to page (1-${pageCount})`);
        if (!value) return;
        const cleaned = String(value).trim();
        if (!/^[0-9]+$/.test(cleaned)) {
          showToast("Invalid page", "error");
          return;
        }
        const pageNum = Number(cleaned);
        if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > pageCount) {
          showToast("Invalid page", "error");
          return;
        }
        const target = pageNum - 1;
        state.pageByMode[state.mode] = target;
        ensurePageData(state.mode, target);
      };
    }
    if (variantMoreBtn && variantStripEl) {
      variantMoreBtn.onclick = () => {
        variantStripEl.scrollBy({ top: 64, behavior: "smooth" });
      };
    }
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
          if (action === "share") shareItem(item);
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
        state.groupOrder = new Map();
        state.groupLatest = new Map();
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
      hideModToastToggle.onclick = () => {
        const enabled = !hideModToastToggle.classList.contains("active");
        hideModToastToggle.classList.toggle("active", enabled);
        hideModToastToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
        hideModToastToggle.textContent = enabled ? "Toast hidden" : "Hide moderation toast";
        chrome.storage.local.set({ gvHideModerationToast: enabled });
        chrome.runtime.sendMessage({ action: "grokViewerSetHideModToast", enabled });
      };
    }
    if (downloadBtn) downloadBtn.onclick = downloadOne;
    if (shareBtn)
      shareBtn.onclick = () => {
        const item = state.items[state.selectedIndex];
        if (item) shareItem(item);
      };
    if (deleteBtn) deleteBtn.onclick = deleteOne;
    if (autoNextBtn) autoNextBtn.onclick = toggleAutoAdvance;
    if (githubBtn) {
      githubBtn.onclick = () => {
        openChangelogModal();
      };
    }
    if (changelogClose) changelogClose.onclick = closeChangelogModal;
    if (changelogModal) {
      changelogModal.onclick = (event) => {
        if (event.target === changelogModal) closeChangelogModal();
      };
    }
    if (changelogGithub) {
      changelogGithub.onclick = () => {
        window.open("https://github.com/exabeet/grok-viewer", "_blank", "noopener");
      };
    }
    if (modeGridBtn) {
      modeGridBtn.onclick = () => {
        setViewMode("grid", true);
        hideViewModeModal();
      };
    }
    if (modeNormalBtn) {
      modeNormalBtn.onclick = () => {
        setViewMode("normal", true);
        hideViewModeModal();
      };
    }
    if (viewModeBtn) {
      viewModeBtn.onclick = () => {
        const next = state.viewMode === "grid" ? "normal" : "grid";
        setViewMode(next, true);
      };
    }
    if (viewModeModal) {
      viewModeModal.onclick = (event) => {
        if (event.target === viewModeModal) return;
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
      if (changelogModal && changelogModal.classList.contains("open") && event.key === "Escape") {
        closeChangelogModal();
        return;
      }
      if (!lightboxEl || !lightboxEl.classList.contains("open")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "ArrowDown") stepVariant(1);
      if (event.key === "ArrowUp") stepVariant(-1);
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
    initHideModToastTooltip();
    setStatus("Press Refresh.");
    applyModeUI();
    updatePager();
    chrome.storage.local.get([STORAGE_KEY, VIEW_MODE_KEY], (data) => {
      const storedMode = data && data[VIEW_MODE_KEY] ? data[VIEW_MODE_KEY] : "";
      if (storedMode === "grid" || storedMode === "normal") {
        state.viewMode = storedMode;
        if (brandTitleEl) {
          brandTitleEl.textContent = state.viewMode === "grid" ? "Grok-Viewer Grid" : "Grok-Viewer";
        }
        if (viewModeIcon) {
          const icon = state.viewMode === "grid" ? "images/grid.svg" : "images/normal.svg";
          const alt = state.viewMode === "grid" ? "Grid view" : "Normal view";
          viewModeIcon.src = chrome.runtime.getURL(icon);
          viewModeIcon.alt = alt;
        }
        if (viewModeBtn) {
          viewModeBtn.dataset.tooltip =
            state.viewMode === "grid"
              ? "Click to return to the Grok-Viewer normal version"
              : "Click to switch to the Grok-Viewer Grid version";
        }
        hideViewModeModal();
      } else {
        showViewModeModal();
      }
      const cached = data && data[STORAGE_KEY] ? data[STORAGE_KEY] : null;
      const cachedItems = cached && Array.isArray(cached.items) ? cached.items : [];
      if (cachedItems.length) {
        const modeState = getModeState("videos");
        const pageItems = dedupeItems(cachedItems)
          .slice(0, state.pageSize)
          .map((item) => minimizeVideoItem(item))
          .filter(Boolean);
        modeState.pageCache.set(0, pageItems);
        pageItems.forEach((item) => {
          const key = getItemKey(item);
          if (key) modeState.seen.add(key);
        });
        modeState.totalLoaded = pageItems.length;
        modeState.maxPageLoaded = pageItems.length ? 0 : -1;
        updateItems();
        setStatus("Ready.");
      }
      refresh();
    });
  };

  initUI();
})();
