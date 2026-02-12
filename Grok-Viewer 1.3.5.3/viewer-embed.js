(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const VIEW_MODE_KEY = "grokViewerViewMode";
  const SETTINGS_KEY = "grokViewerSettings";
  const DOWNLOADED_KEY = "grokViewerDownloaded";
  const API_URL = "/rest/media/post/list";
  const DELETE_URL = "/rest/media/post/delete";
  const LIKE_URL = "/rest/media/post/like";
  const UNLIKE_URL = "/rest/media/post/unlike";
  const POST_GET_URL = "/rest/media/post/get";
  const REGEN_CONVERSATION_URL = "/rest/app-chat/conversations/new";
  const LIMIT = 40;
  const SOURCE = "MEDIA_POST_SOURCE_LIKED";
  const REGEN_COOLDOWN_MS = 15000;
  const REGEN_MAX_CONCURRENT = 2;
  const REGEN_LOG_LIMIT = 80;
  const REGEN_DEBUG_ENABLED = false;

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

  const DEFAULT_SETTINGS = {
    downloadMode: "ask_each",
    folderPath: "",
    askEachFolderPath: "",
    bulkTarget: 32,
    autoRefreshAlways: false,
    fastBulk: true,
    downloadSettingsGuideDone: false,
    skipIntroModal: false,
    skipNestedGuide: false,
    nestedGuideShown: false,
    skipNormalGuide: false,
    normalGuideShown: false
  };

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
    autoAdvanceAll: false,
    thumbAutoplay: false,
    sortOrder: "desc",
    renderToken: 0,
    pageSize: 38,
    pageByMode: { videos: 0, images: 0 },
    pageLoading: false,
    settings: { ...DEFAULT_SETTINGS },
    downloadedLookup: { videos: new Set(), images: new Set() },
    groupOrder: new Map(),
    groupLatest: new Map(),
    deleteAllRunning: { videos: false, images: false },
    modeState: {
      videos: createModeState(),
      images: createModeState()
    }
  };
  const THUMB_LOW_QUALITY_THRESHOLD = 50;

  const hdMetaByPostId = new Map();
  const hdProbeInFlight = new Set();
  const hdProbeQueued = new Set();
  const hdProbeQueue = [];
  let hdProbeRunning = 0;
  const HD_PROBE_MAX = 2;

  const isDeleteAllRunning = (mode) =>
    Boolean(mode && state.deleteAllRunning && state.deleteAllRunning[mode]);

  const isAnyDeleteAllRunning = () => isDeleteAllRunning("videos") || isDeleteAllRunning("images");

  const isBusyFromDeleteOnly = () => Boolean(state.busy && isAnyDeleteAllRunning() && !state.pageLoading);

  const beginDeleteAllRun = (mode) => {
    if (!mode || !state.deleteAllRunning) return;
    state.deleteAllRunning[mode] = true;
    state.busy = true;
  };

  const endDeleteAllRun = (mode) => {
    if (!mode || !state.deleteAllRunning) return;
    state.deleteAllRunning[mode] = false;
    if (!isAnyDeleteAllRunning()) {
      state.busy = false;
    }
  };

  let lastUserKey = "";
  let chosenFolderHandle = null;
  const supportsFolderHandles = () => typeof window.showDirectoryPicker === "function";

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
            chrome.storage.local.remove(DOWNLOADED_KEY, () => {});
            resetAllModes();
            updateItems();
          }
          resolve(changed);
        });
      });
    });

  const loadSettings = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (data) => {
        const stored = data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : {};
        state.settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
        state.settings.folderPath = sanitizeFolderPath(state.settings.folderPath || "");
        state.settings.askEachFolderPath = sanitizeFolderPath(state.settings.askEachFolderPath || "");
        state.settings.bulkTarget = getBulkTarget();
        resolve(state.settings);
      });
    });

  const persistSettings = () => {
    chrome.storage.local.set({ [SETTINGS_KEY]: state.settings }, () => {});
  };

  const getDownloadedStore = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(DOWNLOADED_KEY, (data) => {
        const stored = data && data[DOWNLOADED_KEY] ? data[DOWNLOADED_KEY] : {};
        if (!stored.videos) stored.videos = {};
        if (!stored.images) stored.images = {};
        resolve(stored);
      });
    });

  const loadDownloadedLookup = async () => {
    const store = await getDownloadedStore();
    state.downloadedLookup = {
      videos: new Set(Object.keys(store.videos || {})),
      images: new Set(Object.keys(store.images || {}))
    };
  };

  const recordDownloadedItems = (mode, items) => {
    if (!items || !items.length) return;
    const keys = items
      .map((item) => (mode === "images" ? getImageKey(item) : getItemKey(item)))
      .filter(Boolean);
    if (!keys.length) return;
    const lookup = state.downloadedLookup && state.downloadedLookup[mode] ? state.downloadedLookup[mode] : null;
    if (lookup) keys.forEach((key) => lookup.add(key));
    chrome.storage.local.get(DOWNLOADED_KEY, (data) => {
      const stored = data && data[DOWNLOADED_KEY] ? data[DOWNLOADED_KEY] : {};
      const bucket = stored[mode] || {};
      keys.forEach((key) => {
        bucket[key] = Date.now();
      });
      stored[mode] = bucket;
      chrome.storage.local.set({ [DOWNLOADED_KEY]: stored }, () => {});
    });
  };

  const sanitizeFolderPath = (value) => {
    if (!value) return "";
    const cleaned = String(value)
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\.\./g, "")
      .replace(/[^a-zA-Z0-9/_-]/g, "");
    return cleaned.replace(/\/+$/, "");
  };

  const getDownloadMode = () => {
    const mode = state.settings && state.settings.downloadMode ? state.settings.downloadMode : "ask_each";
    if (mode === "ask_each" || mode === "folder_once" || mode === "default_auto") return mode;
    return "ask_each";
  };

  const getBulkTarget = () => {
    const target = Number(state.settings && state.settings.bulkTarget ? state.settings.bulkTarget : 32);
    if (target === 64 || target === 120) return target;
    return 32;
  };

  const getAskEachFolderPath = () =>
    sanitizeFolderPath(state.settings && state.settings.askEachFolderPath ? state.settings.askEachFolderPath : "");

  const applyFolderPrefix = (filename, folderPath) => {
    const cleanFilename = String(filename || "").replace(/^\/+/, "");
    if (!cleanFilename || !folderPath) return cleanFilename;
    if (cleanFilename.startsWith(`${folderPath}/`)) return cleanFilename;
    if (cleanFilename.includes("/")) return cleanFilename;
    return `${folderPath}/${cleanFilename}`;
  };

  const resolveDownloadFilename = (filename) => {
    const mode = getDownloadMode();
    if (mode === "folder_once") {
      const folderPath = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
      return applyFolderPrefix(filename, folderPath);
    }
    if (mode === "ask_each") {
      return applyFolderPrefix(filename, getAskEachFolderPath());
    }
    return filename;
  };

  const resolveSaveAs = () => {
    const mode = getDownloadMode();
    if (mode === "ask_each") return true;
    return false;
  };

  const ensureFolderModeReady = async () => {
    if (getDownloadMode() !== "folder_once") return true;
    if (!supportsFolderHandles()) {
      const existingPath = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
      if (existingPath) return true;
      const pickedLegacy = await pickFolderWithDialog();
      if (!pickedLegacy) return false;
      state.settings.folderPath = sanitizeFolderPath(pickedLegacy.path || "Grok-Viewer");
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    if (chosenFolderHandle) {
      try {
        if (typeof chosenFolderHandle.queryPermission === "function") {
          let permission = await chosenFolderHandle.queryPermission({ mode: "readwrite" });
          if (permission !== "granted" && typeof chosenFolderHandle.requestPermission === "function") {
            permission = await chosenFolderHandle.requestPermission({ mode: "readwrite" });
          }
          if (permission !== "granted") return false;
        }
        return true;
      } catch (error) {}
    }
    const existing = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
    if (existing) return true;
    const picked = await pickFolderWithDialog();
    if (!picked) return false;
    chosenFolderHandle = picked.handle || null;
    state.settings.folderPath = sanitizeFolderPath(picked.path || "Grok-Viewer");
    state.settings.downloadMode = "folder_once";
    persistSettings();
    updateSettingsUI();
    return true;
  };

  const pickFolderWithDialog = async () => {
    if (supportsFolderHandles()) {
      try {
        if (window.showDirectoryPicker) {
          const handle = await window.showDirectoryPicker({ mode: "readwrite" });
          const picked = sanitizeFolderPath(handle && handle.name ? handle.name : "");
          if (picked) return { path: picked, handle };
        }
      } catch (error) {}
    }
    try {
      const picked = await new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.setAttribute("webkitdirectory", "true");
        input.setAttribute("directory", "true");
        input.multiple = true;
        input.style.display = "none";
        let resolved = false;
        const cleanup = () => {
          if (input.parentNode) input.parentNode.removeChild(input);
        };
        const finish = (value) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(value);
        };
        input.onchange = () => {
          const entries = input.webkitEntries && input.webkitEntries.length ? input.webkitEntries : null;
          let folder = "";
          if (entries && entries[0]) {
            const fullPath = String(entries[0].fullPath || "");
            folder = fullPath ? fullPath.replace(/^\/+/, "").split("/")[0] : entries[0].name || "";
          }
          if (!folder) {
            const file = input.files && input.files[0] ? input.files[0] : null;
            const rel = file && file.webkitRelativePath ? String(file.webkitRelativePath) : "";
            folder = rel ? rel.split("/")[0] : "";
          }
          const cleaned = sanitizeFolderPath(folder);
          finish(cleaned ? { path: cleaned, handle: null } : null);
        };
        input.oncancel = () => finish(null);
        (document.body || document.documentElement).appendChild(input);
        input.click();
        setTimeout(() => finish(null), 45000);
      });
      return picked;
    } catch (error) {
      return null;
    }
  };

  const getFolderDisplayValue = () => {
    const folderPath = sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "");
    if (!folderPath) return "";
    const tail = folderPath.split("/").filter(Boolean).pop() || folderPath;
    return `${folderPath}/${tail}`;
  };

  const pickFolderAndEnableMode = async (forcePick) => {
    const existing = sanitizeFolderPath(state.settings.folderPath || "");
    if (!supportsFolderHandles() && !forcePick && existing) {
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    if (!forcePick && existing && chosenFolderHandle) {
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    const picked = await pickFolderWithDialog();
    if (!picked) {
      if (!supportsFolderHandles()) {
        if (!existing) return false;
        state.settings.folderPath = existing;
        state.settings.downloadMode = "folder_once";
        persistSettings();
        updateSettingsUI();
        return true;
      }
      if (!existing || !chosenFolderHandle) return false;
      state.settings.downloadMode = "folder_once";
      persistSettings();
      updateSettingsUI();
      return true;
    }
    chosenFolderHandle = picked.handle || null;
    const folderPath = sanitizeFolderPath(picked.path || existing || "Grok-Viewer");
    state.settings.folderPath = folderPath || "Grok-Viewer";
    state.settings.downloadMode = "folder_once";
    persistSettings();
    updateSettingsUI();
    return true;
  };

  const getLeafFilename = (filename) => {
    const clean = String(filename || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop();
    return clean || `grok-file-${Date.now()}`;
  };

  const splitNameExt = (filename) => {
    const leaf = getLeafFilename(filename);
    const idx = leaf.lastIndexOf(".");
    if (idx <= 0 || idx === leaf.length - 1) return { base: leaf, ext: "" };
    return { base: leaf.slice(0, idx), ext: leaf.slice(idx) };
  };

  const getUniqueLeafName = async (handle, filename) => {
    const { base, ext } = splitNameExt(filename);
    let candidate = `${base}${ext}`;
    let index = 1;
    while (index < 5000) {
      try {
        await handle.getFileHandle(candidate, { create: false });
        candidate = `${base} (${index})${ext}`;
        index += 1;
      } catch (error) {
        return candidate;
      }
    }
    return `${base}-${Date.now()}${ext}`;
  };

  const writeBlobToChosenFolder = async (blob, filename) => {
    const ready = await ensureFolderModeReady();
    if (!ready) return { ok: false, error: "folder-not-ready" };
    if (!chosenFolderHandle) return { ok: false, error: "no-handle" };
    try {
      const leaf = await getUniqueLeafName(chosenFolderHandle, filename);
      const fileHandle = await chosenFolderHandle.getFileHandle(leaf, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, filename: leaf, local: true };
    } catch (error) {
      return { ok: false, error: String(error || "write-failed") };
    }
  };

  let logTimer = null;
  const logLines = [];
  const MAX_LOGS = 200;

  const formatTime = (date) =>
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
      date.getSeconds()
    ).padStart(2, "0")}`;

  const addLog = () => {};

  const addBulkDebug = (message, details) => {
    const base = `[${formatTime(new Date())}] [bulk] ${String(message || "")}`;
    let line = base;
    if (details !== undefined && details !== null && details !== "") {
      line = `${base} ${String(details)}`;
    }
    try {
      console.log(line);
    } catch (error) {}
  };

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

  const isUnavailableUrlValue = (value) => {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return true;
    if (text === "-" || text === "n/a" || text === "na") return true;
    if (text === "null" || text === "undefined" || text === "none") return true;
    return /^not[\s_-]*available$/.test(text);
  };

  const normalizeUrl = (url) => {
    const raw = typeof url === "string" ? url.trim() : "";
    if (isUnavailableUrlValue(raw)) return "";
    if (raw.startsWith("http")) return raw;
    if (raw.startsWith("users/") || raw.startsWith("/users/")) {
      const trimmed = raw.replace(/^\//, "");
      return `https://assets.grok.com/${trimmed}`;
    }
    if (raw.startsWith("/imagine-public/")) {
      return `https://imagine-public.x.ai${raw}`;
    }
    if (raw.startsWith("imagine-public/")) {
      return `https://imagine-public.x.ai/${raw}`;
    }
    try {
      const resolved = new URL(raw, window.location.href).toString();
      if (/(?:\/|%2f)(?:not%20available|undefined|null)(?:\/|$|\?|#)/i.test(resolved)) {
        return "";
      }
      return resolved;
    } catch (error) {
      return "";
    }
  };

  const shouldForceLowQualityThumbs = () => {
    const mode = state && state.mode === "images" ? "images" : "videos";
    const modeState = state && state.modeState ? state.modeState[mode] : null;
    const totalLoaded = Number((modeState && modeState.totalLoaded) || 0);
    const listCount =
      mode === "images"
        ? Number((state && state.imageItems && state.imageItems.length) || 0)
        : Number((state && state.videoItems && state.videoItems.length) || 0);
    const visibleCount = Number((state && state.items && state.items.length) || 0);
    return Math.max(totalLoaded, listCount, visibleCount) > THUMB_LOW_QUALITY_THRESHOLD;
  };

  const optimizeThumbUrl = (url, options = {}) => {
    if (!url) return "";
    try {
      const parsed = new URL(url, window.location.href);
      const host = (parsed.hostname || "").toLowerCase();
      if (!host.includes("assets.grok.com") && !host.includes("imagine-public.x.ai")) return parsed.toString();
      const pathname = (parsed.pathname || "").toLowerCase();
      const isVideoPath = pathname.endsWith(".mp4") || pathname.includes("generated_video.mp4");
      if (!parsed.searchParams.has("cache")) parsed.searchParams.set("cache", "1");
      if (isVideoPath) {
        parsed.searchParams.delete("w");
        parsed.searchParams.delete("q");
        parsed.searchParams.delete("dpr");
      } else {
        const forceLow = Boolean((options && options.forceLow) || shouldForceLowQualityThumbs());
        const imageGridLow = Boolean(options && options.imageGridLow);
        if (forceLow) {
          parsed.searchParams.set("w", "44");
          parsed.searchParams.set("q", "3");
        } else {
          parsed.searchParams.set("w", imageGridLow ? "56" : "88");
          parsed.searchParams.set("q", imageGridLow ? "5" : "8");
        }
        parsed.searchParams.set("dpr", "1");
      }
      return parsed.toString();
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

  const toPositiveSize = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.round(num);
  };

  const parseOrientationHint = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1;
    const text = String(value).trim().toLowerCase();
    if (!text) return null;
    if (text.includes("portrait") || text.includes("vertical")) return true;
    if (text.includes("landscape") || text.includes("horizontal")) return false;
    const ratioMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*[:x/]\s*([0-9]+(?:\.[0-9]+)?)/);
    if (ratioMatch) {
      const a = Number(ratioMatch[1]);
      const b = Number(ratioMatch[2]);
      if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return b > a;
    }
    const ratioNum = Number(text);
    if (Number.isFinite(ratioNum) && ratioNum > 0) return ratioNum < 1;
    return null;
  };

  const extractMediaDimensions = (post) => {
    if (!post) return { width: 0, height: 0 };
    const candidates = [
      [post.mediaWidth, post.mediaHeight],
      [post.width, post.height],
      [post.videoWidth, post.videoHeight],
      [post.imageWidth, post.imageHeight],
      [post.pixelWidth, post.pixelHeight],
      [post.displayWidth, post.displayHeight],
      [post.thumbWidth, post.thumbHeight],
      [post.thumbnailWidth, post.thumbnailHeight],
      [post.previewWidth, post.previewHeight],
      [post.hdWidth, post.hdHeight],
      [post.media && post.media.width, post.media && post.media.height],
      [post.dimensions && post.dimensions.width, post.dimensions && post.dimensions.height],
      [post.size && post.size.width, post.size && post.size.height],
      [post.metadata && post.metadata.width, post.metadata && post.metadata.height],
      [post.mediaMetadata && post.mediaMetadata.width, post.mediaMetadata && post.mediaMetadata.height]
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const pair = candidates[i];
      const width = toPositiveSize(pair[0]);
      const height = toPositiveSize(pair[1]);
      if (width && height) return { width, height };
    }
    return { width: 0, height: 0 };
  };

  const extractIsPortrait = (post, width, height) => {
    if (width && height) return height > width;
    const hints = [
      post && post.orientation,
      post && post.aspect,
      post && post.aspectRatio,
      post && post.mediaAspectRatio,
      post && post.ratio
    ];
    for (let i = 0; i < hints.length; i += 1) {
      const parsed = parseOrientationHint(hints[i]);
      if (parsed !== null) return parsed;
    }
    return null;
  };

  const gcdInt = (a, b) => {
    let x = Math.abs(Math.trunc(Number(a) || 0));
    let y = Math.abs(Math.trunc(Number(b) || 0));
    while (y) {
      const next = x % y;
      x = y;
      y = next;
    }
    return x || 1;
  };

  const normalizeAspectRatioText = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const ratioMatch = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*[:x/]\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (ratioMatch) {
      const left = Number(ratioMatch[1]);
      const right = Number(ratioMatch[2]);
      if (Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0) {
        const normLeft = Math.round(left * 1000);
        const normRight = Math.round(right * 1000);
        const div = gcdInt(normLeft, normRight);
        return `${Math.round(normLeft / div)}:${Math.round(normRight / div)}`;
      }
    }
    return "";
  };

  const pickAspectRatioFromDimensions = (width, height) => {
    const w = toPositiveSize(width);
    const h = toPositiveSize(height);
    if (!w || !h) return "2:3";
    const ratio = w / h;
    const candidates = [
      { label: "1:1", value: 1 },
      { label: "2:3", value: 2 / 3 },
      { label: "3:2", value: 3 / 2 },
      { label: "9:16", value: 9 / 16 },
      { label: "16:9", value: 16 / 9 },
      { label: "4:5", value: 4 / 5 },
      { label: "5:4", value: 5 / 4 }
    ];
    let best = candidates[0];
    let bestDiff = Math.abs(ratio - best.value);
    for (let i = 1; i < candidates.length; i += 1) {
      const diff = Math.abs(ratio - candidates[i].value);
      if (diff < bestDiff) {
        best = candidates[i];
        bestDiff = diff;
      }
    }
    return best.label;
  };

  const extractResolutionPair = (post) => {
    if (!post) return { width: 0, height: 0 };
    const fromResolution = post.resolution || {};
    const width = toPositiveSize(fromResolution.width || post.width || 0);
    const height = toPositiveSize(fromResolution.height || post.height || 0);
    return { width, height };
  };

  const parseResolutionHeightFromName = (value) => {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return null;
    const match = text.match(/(\d{3,4})\s*p\b/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const isHdResolutionMeta = (resolutionName, width, height) => {
    const namedHeight = parseResolutionHeightFromName(resolutionName);
    if (namedHeight !== null) return namedHeight >= 720;
    const w = toPositiveSize(width);
    const h = toPositiveSize(height);
    if (!w && !h) return false;
    return Math.max(w, h) >= 780;
  };

  const hasHdResolutionSignal = (item) => {
    if (!item) return false;
    if (item.isHD === true || item.isHD === false) return true;
    const namedHeight = parseResolutionHeightFromName(item.resolutionName);
    if (namedHeight !== null) return true;
    const w = toPositiveSize(item.resolutionWidth || 0);
    const h = toPositiveSize(item.resolutionHeight || 0);
    return Boolean(w || h);
  };

  const isHdVideoItem = (item) => {
    if (!item) return false;
    if (hasHdUrlCandidate(item)) return true;
    const postId = String((item && item.postId) || "").trim();
    if (item.isHD === true) return true;
    if (item.isHD === false && hasHdResolutionSignal(item)) return false;
    const cached = postId ? hdMetaByPostId.get(postId) : null;
    if (cached && cached.hasSignal) return cached.isHD === true;
    const width = toPositiveSize(item.resolutionWidth || 0);
    const height = toPositiveSize(item.resolutionHeight || 0);
    if (!parseResolutionHeightFromName(item.resolutionName) && !width && !height) return false;
    return isHdResolutionMeta(item.resolutionName, width, height);
  };

  const isHdUrl = (url) => /(?:_hd\.mp4)(?:$|[?#])/i.test(String(url || ""));

  const hasHdUrlCandidate = (item) => {
    if (!item) return false;
    const hdUrl = normalizeUrl(String(item.hdMediaUrl || ""));
    const mediaUrl = normalizeUrl(String(item.mediaUrl || item.url || ""));
    return isHdUrl(hdUrl) || isHdUrl(mediaUrl);
  };

  const getPostPromptText = (post) => {
    if (!post) return "";
    const raw =
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
      "";
    return typeof raw === "string" ? raw.trim() : raw ? String(raw).trim() : "";
  };

  const buildItem = (post, parentPostId, parentImageUrl, parentPrompt) => {
    if (!post) return null;
    const hdMediaUrl = normalizeUrl(post.hdMediaUrl || "");
    const mediaUrl = normalizeUrl(post.mediaUrl || "");
    const playbackUrl = isMp4(mediaUrl, post.mimeType) ? mediaUrl : hdMediaUrl;
    if (!isMp4(playbackUrl, post.mimeType)) return null;
    const sourceImageUrl = normalizeUrl(
      parentImageUrl ||
        post.sourceImageUrl ||
        post.parentImageUrl ||
        (post.originalPost && post.originalPost.mediaUrl) ||
        ""
    );
    const poster = optimizeThumbUrl(normalizeUrl(post.thumbnailImageUrl || post.previewImageUrl || sourceImageUrl || ""));
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
    const dimensions = extractMediaDimensions(post);
    const targetResolution = extractResolutionPair(post);
    const resolutionName = String(post.resolutionName || "").trim();
    const resolutionWidth = targetResolution.width;
    const resolutionHeight = targetResolution.height;
    const hasResolutionSignal =
      parseResolutionHeightFromName(resolutionName) !== null || Boolean(resolutionWidth || resolutionHeight);
    const hasHdAsset = isHdUrl(hdMediaUrl);
    const isPortrait = extractIsPortrait(post, dimensions.width, dimensions.height);
    return {
      id: post.id || playbackUrl,
      url: playbackUrl,
      mediaUrl: playbackUrl,
      playbackUrl,
      hdMediaUrl: isMp4(hdMediaUrl, post.mimeType) ? hdMediaUrl : "",
      poster,
      postId: post.id || "",
      originalPostId: post.originalPostId || "",
      parentPostId: post.parentPostId || parentPostId || post.originalPostId || "",
      sourceImageUrl,
      promptText: looksLikeImagePrompt ? "" : promptCandidate,
      hasPrompt,
      createdAt: getCreatedAtValue(post),
      mimeType: post.mimeType || "",
      resolutionName,
      resolutionWidth,
      resolutionHeight,
      isHD: hasHdAsset ? true : hasResolutionSignal ? isHdResolutionMeta(resolutionName, resolutionWidth, resolutionHeight) : null,
      mediaWidth: dimensions.width,
      mediaHeight: dimensions.height,
      isPortrait
    };
  };

  const buildImageItem = (post) => {
    if (!post) return null;
    const rawUrl = post.mediaUrl || "";
    if (!isImage(rawUrl, post.mimeType)) return null;
    const url = normalizeUrl(rawUrl);
    if (!isImage(url, post.mimeType)) return null;
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
      "";
    const promptCandidate =
      typeof promptCandidateRaw === "string" ? promptCandidateRaw.trim() : promptCandidateRaw ? String(promptCandidateRaw) : "";
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
    const dimensions = extractMediaDimensions(post);
    const isPortrait = extractIsPortrait(post, dimensions.width, dimensions.height);
    return {
      id: post.id || url,
      url,
      poster: optimizeThumbUrl(url),
      postId: post.id || "",
      originalPostId: post.originalPostId || "",
      parentPostId: post.parentPostId || post.originalPostId || "",
      createdAt: getCreatedAtValue(post),
      promptText: promptCandidate,
      childVideoIds,
      mediaWidth: dimensions.width,
      mediaHeight: dimensions.height,
      isPortrait
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
    const clean = stripUrlForKey(url);
    let match = clean.match(/\/generated\/([0-9a-f-]{36})\/generated_video\.mp4$/i);
    if (match) return match[1];
    match = clean.match(/\/share-videos\/([0-9a-f-]{36})\.mp4$/i);
    if (match) return match[1];
    match = clean.match(/\/([0-9a-f-]{36})\.mp4$/i);
    return match ? match[1] : "";
  };

  const extractImageId = (url) => {
    if (!url) return "";
    const match = url.match(/imagine-public\/images\/([0-9a-f-]{36})\.(?:jpg|jpeg|png|webp)/i);
    return match ? match[1] : "";
  };

  const getVideoDedupKeys = (item) => {
    if (!item) return [];
    const keys = [];
    const postIdKey = item.postId ? `post:${item.postId}` : "";
    const urlCandidate = item.url || item.playbackUrl || item.mediaUrl || item.hdMediaUrl || "";
    const mp4Id = extractMp4Id(urlCandidate);
    const mp4Key = mp4Id ? `mp4:${mp4Id}` : "";
    const urlKey = urlCandidate ? `url:${stripUrlForKey(urlCandidate)}` : "";
    if (postIdKey) keys.push(postIdKey);
    if (mp4Key) keys.push(mp4Key);
    if (urlKey) keys.push(urlKey);
    return Array.from(new Set(keys));
  };

  const getItemKey = (item) => {
    const keys = getVideoDedupKeys(item);
    return keys[0] || "";
  };

  const resolveActiveItem = (item) => {
    if (!item) return null;
    if (item.variants && item.variants.length) {
      const index = Number.isFinite(item.activeIndex) ? item.activeIndex : 0;
      return item.variants[index] || item.variants[0] || item;
    }
    return item;
  };

  const isLandscapeMediaItem = (item) => {
    if (!item) return false;
    const width = toPositiveSize(item.mediaWidth);
    const height = toPositiveSize(item.mediaHeight);
    if (width && height) return width >= height;
    if (item.isPortrait === true) return false;
    if (item.isPortrait === false) return true;
    return false;
  };

  const getPlaybackCandidates = (item) => {
    if (!item) return [];
    const candidates = [item.playbackUrl, item.mediaUrl, item.url, item.hdMediaUrl]
      .map((url) => optimizeThumbUrl(normalizeUrl(url || "")))
      .filter((url) => isMp4(url, item.mimeType));
    return Array.from(new Set(candidates));
  };

  let mediaPreconnectReady = false;
  const ensureMediaPreconnect = () => {
    if (mediaPreconnectReady) return;
    mediaPreconnectReady = true;
    const hosts = ["https://assets.grok.com", "https://imagine-public.x.ai", "https://grok.com"];
    hosts.forEach((host) => {
      if (document.head && document.head.querySelector(`link[data-gv-preconnect='${host}']`)) return;
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = host;
      link.crossOrigin = "anonymous";
      link.setAttribute("data-gv-preconnect", host);
      if (document.head) document.head.appendChild(link);
    });
  };

  const prewarmVideoSlots = [];
  let prewarmHostEl = null;
  const ensurePrewarmHost = () => {
    if (prewarmHostEl && prewarmHostEl.isConnected) return prewarmHostEl;
    const host = document.createElement("div");
    host.id = "gv-prewarm-host";
    host.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1;";
    (document.body || document.documentElement).appendChild(host);
    prewarmHostEl = host;
    return prewarmHostEl;
  };
  const getPrewarmVideoSlot = (index) => {
    if (prewarmVideoSlots[index]) return prewarmVideoSlots[index];
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.autoplay = false;
    el.loop = false;
    el.style.display = "none";
    const host = ensurePrewarmHost();
    if (host) host.appendChild(el);
    prewarmVideoSlots[index] = el;
    return el;
  };

  const prewarmPlaybackSource = (slotIndex, sourceUrl) => {
    const el = getPrewarmVideoSlot(slotIndex);
    if (!el || !sourceUrl) return;
    if (el.dataset.src === sourceUrl) return;
    el.dataset.src = sourceUrl;
    try {
      el.src = sourceUrl;
      el.load();
    } catch (error) {}
  };

  const prewarmAroundCurrentSelection = () => {
    if (!lightboxEl || !lightboxEl.classList.contains("open")) return;
    if (state.mode === "images" || !state.items.length) return;
    ensureMediaPreconnect();
    ensurePrewarmHost();
    const total = state.items.length;
    const indexes = [state.selectedIndex, (state.selectedIndex + 1) % total, (state.selectedIndex - 1 + total) % total];
    const seen = new Set();
    let slotIndex = 0;
    const enqueueSource = (candidateItem) => {
      const source = getPlaybackCandidates(candidateItem)[0] || "";
      if (!source || seen.has(source)) return;
      seen.add(source);
      prewarmPlaybackSource(slotIndex, source);
      slotIndex += 1;
    };
    for (let i = 0; i < indexes.length; i += 1) {
      const group = state.items[indexes[i]];
      const active = resolveActiveItem(group);
      enqueueSource(active);
      if (i === 0 && group && group.variants && group.variants.length > 1) {
        const current = Number.isFinite(group.activeIndex) ? group.activeIndex : 0;
        const nextVariant = group.variants[(current + 1) % group.variants.length];
        enqueueSource(nextVariant);
      }
      if (slotIndex >= 5) break;
    }
  };

  const resolveVariantPreview = (variant, group) => {
    const imageCandidates = [
      variant && variant.poster,
      variant && variant.sourceImageUrl,
      group && group.sourceImageUrl
    ];
    for (let i = 0; i < imageCandidates.length; i += 1) {
      const candidate = optimizeThumbUrl(normalizeUrl(imageCandidates[i] || ""));
      if (!candidate) continue;
      if (!isMp4(candidate, variant && variant.mimeType)) {
        return { url: candidate, useVideo: false };
      }
    }
    const videoCandidate = optimizeThumbUrl(
      normalizeUrl(
        (variant && (variant.playbackUrl || variant.mediaUrl || variant.url || variant.hdMediaUrl)) || ""
      )
    );
    if (!videoCandidate) return { url: "", useVideo: false };
    return { url: videoCandidate, useVideo: isMp4(videoCandidate, variant && variant.mimeType) };
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
    const sorted = (group.items || []).slice().sort((a, b) => (toTime(a.createdAt) - toTime(b.createdAt)) * direction);
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
    const mergedPrimary = normalizeUrl(merged.playbackUrl || merged.mediaUrl || merged.url || "");
    const extraPrimary = normalizeUrl(extra.playbackUrl || extra.mediaUrl || extra.url || "");
    const mergedHasPlayable = isMp4(mergedPrimary, merged.mimeType);
    const extraHasPlayable = isMp4(extraPrimary, extra.mimeType);
    const extraUrl = normalizeUrl(extra.url || "");
    if (!merged.url && extraUrl) merged.url = extraUrl;
    if (!merged.hdMediaUrl && extra.hdMediaUrl) merged.hdMediaUrl = extra.hdMediaUrl;
    if (!merged.mediaUrl && extra.mediaUrl) merged.mediaUrl = extra.mediaUrl;
    if (!merged.playbackUrl && extra.playbackUrl) merged.playbackUrl = extra.playbackUrl;
    if (!mergedHasPlayable && extraHasPlayable) {
      if (extraUrl) merged.url = extraUrl;
      if (extra.mediaUrl) merged.mediaUrl = normalizeUrl(extra.mediaUrl);
      if (extra.playbackUrl) merged.playbackUrl = normalizeUrl(extra.playbackUrl);
      if (extra.hdMediaUrl) merged.hdMediaUrl = normalizeUrl(extra.hdMediaUrl);
    }
    if (!merged.mimeType && extra.mimeType) merged.mimeType = extra.mimeType;
    if (!merged.sourceImageUrl && extra.sourceImageUrl) merged.sourceImageUrl = extra.sourceImageUrl;
    if (!merged.promptText && extra.promptText) merged.promptText = extra.promptText;
    if (!merged.parentPostId && extra.parentPostId) merged.parentPostId = extra.parentPostId;
    if (merged.hasPrompt === null || merged.hasPrompt === undefined) {
      if (extra.hasPrompt !== null && extra.hasPrompt !== undefined) merged.hasPrompt = extra.hasPrompt;
    }
    if ((!merged.mediaWidth || !merged.mediaHeight) && extra.mediaWidth && extra.mediaHeight) {
      merged.mediaWidth = extra.mediaWidth;
      merged.mediaHeight = extra.mediaHeight;
    }
    const mergedResHeight = parseResolutionHeightFromName(merged.resolutionName);
    const extraResHeight = parseResolutionHeightFromName(extra.resolutionName);
    if (
      (!merged.resolutionName && extra.resolutionName) ||
      (extraResHeight !== null && (mergedResHeight === null || extraResHeight > mergedResHeight))
    ) {
      merged.resolutionName = extra.resolutionName;
    }
    const mergedResMax = Math.max(toPositiveSize(merged.resolutionWidth), toPositiveSize(merged.resolutionHeight));
    const extraResMax = Math.max(toPositiveSize(extra.resolutionWidth), toPositiveSize(extra.resolutionHeight));
    if (
      ((!merged.resolutionWidth || !merged.resolutionHeight) && extra.resolutionWidth && extra.resolutionHeight) ||
      (extraResMax > mergedResMax && extra.resolutionWidth && extra.resolutionHeight)
    ) {
      merged.resolutionWidth = extra.resolutionWidth;
      merged.resolutionHeight = extra.resolutionHeight;
    }
    const mergedHasHdAsset = hasHdUrlCandidate(merged);
    const resolvedIsHD = isHdResolutionMeta(merged.resolutionName, merged.resolutionWidth, merged.resolutionHeight);
    const hasResolvedSignal =
      parseResolutionHeightFromName(merged.resolutionName) !== null ||
      Boolean(toPositiveSize(merged.resolutionWidth) || toPositiveSize(merged.resolutionHeight));
    merged.isHD = mergedHasHdAsset ? true : hasResolvedSignal ? resolvedIsHD : merged.isHD;
    if (merged.isPortrait === null || merged.isPortrait === undefined) {
      if (extra.isPortrait !== null && extra.isPortrait !== undefined) merged.isPortrait = extra.isPortrait;
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
    const canonical = new Map();
    const aliasToCanonical = new Map();
    (items || []).forEach((item) => {
      if (!item) return;
      const keys = getVideoDedupKeys(item);
      if (!keys.length) return;
      const roots = [];
      keys.forEach((key) => {
        const root = aliasToCanonical.get(key);
        if (root && !roots.includes(root)) roots.push(root);
      });
      const primaryRoot = roots[0] || keys[0];
      let merged = pickBetterItem(canonical.get(primaryRoot), item);
      for (let i = 1; i < roots.length; i += 1) {
        const root = roots[i];
        if (!root || root === primaryRoot) continue;
        merged = pickBetterItem(merged, canonical.get(root));
        canonical.delete(root);
        aliasToCanonical.forEach((mappedRoot, aliasKey) => {
          if (mappedRoot === root) aliasToCanonical.set(aliasKey, primaryRoot);
        });
      }
      canonical.set(primaryRoot, merged);
      keys.forEach((key) => aliasToCanonical.set(key, primaryRoot));
    });
    return Array.from(canonical.values()).sort((a, b) => {
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
    let removed = false;
    modeState.pageCache.forEach((value, key) => {
      if (key < currentPage - 1 || key > currentPage + 1) {
        modeState.pageCache.delete(key);
        removed = true;
      }
    });
    if (!removed) return;
    const rebuilt = new Set();
    modeState.pageCache.forEach((pageItems) => {
      (pageItems || []).forEach((item) => {
        if (mode === "images") {
          const key = getImageKey(item);
          if (key) rebuilt.add(key);
          return;
        }
        const keys = getVideoDedupKeys(item);
        keys.forEach((key) => {
          if (key) rebuilt.add(key);
        });
      });
    });
    modeState.seen = rebuilt;
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
      const keys = mode === "images" ? [getImageKey(minItem)] : getVideoDedupKeys(minItem);
      const filteredKeys = keys.filter(Boolean);
      if (!filteredKeys.length) return;
      if (filteredKeys.some((key) => modeState.seen.has(key))) return;
      filteredKeys.forEach((key) => modeState.seen.add(key));
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

  const ensurePageData = async (mode, pageIndex, options = {}) => {
    const silent = !!(options && options.silent);
    if (state.pageLoading) return;
    state.pageLoading = true;
    const modeState = getModeState(mode);
    try {
      if (!silent) setStatus("Loading page...");
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
      if (!silent) setStatus("Page load failed.");
    } finally {
      state.pageLoading = false;
      if (!silent) setReadyStatus();
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
      setReadyStatus();
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
          mediaUrl: item.mediaUrl,
          playbackUrl: item.playbackUrl,
          poster: item.poster,
          sourceImageUrl: item.sourceImageUrl,
          postId: item.postId,
          createdAt: item.createdAt,
          promptText: item.promptText || "",
          hdMediaUrl: item.hdMediaUrl,
          mimeType: item.mimeType,
          resolutionName: item.resolutionName,
          resolutionWidth: item.resolutionWidth,
          resolutionHeight: item.resolutionHeight,
          isHD: item.isHD,
          originalPostId: item.originalPostId,
          parentPostId: item.parentPostId,
          mediaWidth: item.mediaWidth,
          mediaHeight: item.mediaHeight,
          isPortrait: item.isPortrait
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
          promptText: item.promptText || "",
          mimeType: item.mimeType,
          originalPostId: item.originalPostId,
          parentPostId: item.parentPostId,
          childVideoIds: item.childVideoIds || [],
          mediaWidth: item.mediaWidth,
          mediaHeight: item.mediaHeight,
          isPortrait: item.isPortrait
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
    const pageItems = modeState.pageCache.get(page) || [];
    const items = state.mode === "images" ? dedupeImageItems(pageItems) : dedupeItems(pageItems);
    const sorted = sortByCreatedAt(items);
    return isGridMode() ? groupItems(sorted) : sorted;
  };

  const isItemDownloaded = (mode, item) => {
    if (!item) return false;
    const key = mode === "images" ? getImageKey(item) : getItemKey(item);
    if (!key) return false;
    const lookup = state.downloadedLookup && state.downloadedLookup[mode] ? state.downloadedLookup[mode] : null;
    return Boolean(lookup && lookup.has(key));
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

  const collectBulkItems = async (mode, targetCount) => {
    if (!state.downloadedLookup || !state.downloadedLookup[mode]) {
      await loadDownloadedLookup();
    }
    const downloaded = state.downloadedLookup && state.downloadedLookup[mode] ? state.downloadedLookup[mode] : new Set();
    const modeState = getModeState(mode);
    const pageStart = clampPage(mode);
    const maxItems = Math.max(1, targetCount);
    const fresh = [];
    const duplicates = [];
    let dupCount = 0;
    let page = pageStart;
    let safety = 0;
    while (fresh.length < maxItems && safety < 500) {
      if (!modeState.pageCache.has(page)) {
        if (modeState.pageCursors[page] !== undefined) {
          await fetchAndCachePage(mode, page);
        } else {
          while (modeState.pageCursors.length <= page && !modeState.exhausted) {
            const fetchIndex = modeState.pageCursors.length - 1;
            await fetchAndCachePage(mode, fetchIndex);
          }
          if (modeState.pageCursors[page] !== undefined && !modeState.pageCache.has(page)) {
            await fetchAndCachePage(mode, page);
          }
        }
      }
      const pageItems = modeState.pageCache.get(page) || [];
      for (let i = 0; i < pageItems.length; i += 1) {
        const item = pageItems[i];
        const key = mode === "images" ? getImageKey(item) : getItemKey(item);
        if (key && downloaded.has(key)) {
          dupCount += 1;
          if (duplicates.length < maxItems) duplicates.push(item);
          continue;
        }
        fresh.push(item);
        if (fresh.length >= maxItems) break;
      }
      if (modeState.exhausted && page >= modeState.maxPageLoaded) break;
      page += 1;
      safety += 1;
    }
    prunePageCache(mode, pageStart);
    return { fresh, dupCount, duplicates };
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

  const refresh = async (options = {}) => {
    const silent = !!(options && options.silent);
    const includeOtherMode = !!(options && options.includeOtherMode);
    if (state.busy) return;
    state.busy = true;
    if (!silent) setStatus("Refreshing favorites...");
    addLog(silent ? "Auto refresh requested" : "Refresh requested");
    try {
      await ensureUserScope();
      const targetMode = state.mode;
      const targetPage = Math.max(0, state.pageByMode[targetMode] || 0);
      const otherMode = targetMode === "videos" ? "images" : "videos";
      const otherPage = Math.max(0, state.pageByMode[otherMode] || 0);
      resetAllModes();
      await ensurePageData(targetMode, targetPage, { silent });
      if (includeOtherMode) {
        await ensurePageData(otherMode, otherPage, { silent: true });
      }
      chrome.storage.local.set({ [STORAGE_KEY]: { items: state.videoItems, updatedAt: Date.now() } }, () => {});
      addLog(silent ? "Auto refresh completed" : "Refresh completed");
      setReadyStatus();
    } catch (error) {
      addLog(`Refresh failed: ${error.message}`);
      if (!silent) {
        setStatus("Refresh failed.");
      } else {
        setReadyStatus();
      }
    } finally {
      state.busy = false;
      updateActionButtons();
    }
  };

  const stopAutoRefreshLoop = () => {
    if (!autoRefreshTimer) return;
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  };

  const updateAutoRefreshLoop = () => {
    stopAutoRefreshLoop();
    if (!state.settings || !state.settings.autoRefreshAlways) return;
    autoRefreshTimer = setInterval(() => {
      if (state.busy || state.pageLoading) return;
      refresh({ silent: true, includeOtherMode: true });
    }, 5000);
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

  const collectImageDeleteTargetsFromPosts = (posts, imageIds, childVideoIds) => {
    const addChildVideoIds = (post) => {
      if (!post) return;
      (post.childPosts || []).forEach((child) => {
        if (!child || !child.id) return;
        const childUrl = child.hdMediaUrl || child.mediaUrl || "";
        if (isMp4(childUrl, child.mimeType) || child.mediaType === "MEDIA_POST_TYPE_VIDEO") {
          childVideoIds.add(child.id);
        }
      });
      (post.videos || []).forEach((video) => {
        if (!video || !video.id) return;
        const videoUrl = video.hdMediaUrl || video.mediaUrl || "";
        if (isMp4(videoUrl, video.mimeType) || video.mediaType === "MEDIA_POST_TYPE_VIDEO") {
          childVideoIds.add(video.id);
        }
      });
    };
    const addImagePost = (post) => {
      if (!post || !post.id) return;
      const mediaUrl = normalizeUrl(post.mediaUrl || "");
      if (!isImage(mediaUrl, post.mimeType)) return;
      imageIds.add(post.id);
      addChildVideoIds(post);
    };
    (posts || []).forEach((post) => {
      if (!post) return;
      addImagePost(post);
      if (post.originalPost) addImagePost(post.originalPost);
    });
  };

  const collectAllImageDeleteTargets = async (shouldCancel) => {
    let cursor = undefined;
    const seen = new Set();
    const imageIds = new Set();
    const childVideoIds = new Set();
    let safety = 0;
    while (true) {
      if (shouldCancel && shouldCancel()) {
        return { canceled: true, imageIds: [], childVideoIds: [] };
      }
      const data = await fetchPage(cursor);
      const posts = data && data.posts ? data.posts : [];
      collectImageDeleteTargetsFromPosts(posts, imageIds, childVideoIds);
      const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
      if (!nextCursor || seen.has(nextCursor)) break;
      seen.add(nextCursor);
      cursor = nextCursor;
      safety += 1;
      if (safety > 260) break;
    }
    return {
      canceled: false,
      imageIds: Array.from(imageIds),
      childVideoIds: Array.from(childVideoIds)
    };
  };

  const runPool = async (items, concurrency, worker, shouldCancel) => {
    const queue = Array.isArray(items) ? items : [];
    const workersCount = Math.max(1, Math.min(Number(concurrency) || 1, queue.length || 1));
    let nextIndex = 0;
    const runOne = async () => {
      while (nextIndex < queue.length) {
        if (shouldCancel && shouldCancel()) return;
        const currentIndex = nextIndex;
        nextIndex += 1;
        const next = queue[currentIndex];
        if (!next) continue;
        await worker(next);
      }
    };
    const workers = [];
    for (let i = 0; i < workersCount; i += 1) {
      workers.push(runOne());
    }
    await Promise.all(workers);
  };

  const isDeleteAlreadyGoneStatus = (status) => {
    const code = Number(status || 0);
    return code === 404 || code === 410;
  };

  const isRetryableDeleteStatus = (status) => {
    const code = Number(status || 0);
    if (!code) return true;
    if (code === 408 || code === 409 || code === 425 || code === 429) return true;
    return code >= 500;
  };

  const deletePostWithRetry = async (postId, maxRetries) => {
    const retries = Math.max(0, Number(maxRetries) || 0);
    let attempt = 0;
    while (attempt <= retries) {
      let result = null;
      try {
        result = await deletePost(postId);
      } catch (error) {
        result = { ok: false, status: 0 };
      }
      if (result && (result.ok || isDeleteAlreadyGoneStatus(result.status))) {
        return { ok: true, status: result.status || 200 };
      }
      if (attempt >= retries || !isRetryableDeleteStatus(result && result.status)) {
        return { ok: false, status: result ? result.status : 0 };
      }
      attempt += 1;
      await sleep(110 * attempt);
    }
    return { ok: false, status: 0 };
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
    if (!window.confirm("Do you want to delete this file?")) return;
    playActionAudio("delete");
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
    animateThumbRemoval(targetItem.postId);
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
  };

  const deleteOne = async () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    deleteItem(item);
  };

  const deleteAll = async () => {
    if (state.mode === "images") {
      if (isDeleteAllRunning("images")) return;
      if (state.busy && !isBusyFromDeleteOnly()) return;
      if (!window.confirm("Do you want to delete all images?")) return;
      beginDeleteAllRun("images");
      updateActionButtons();
      setStatus("Deleting all images...");
      const cpu = Math.max(2, Number(navigator.hardwareConcurrency) || 6);
      const childSyncConcurrency = Math.min(8, Math.max(3, Math.floor(cpu * 0.7)));
      const deleteConcurrency = Math.min(10, Math.max(4, Math.floor(cpu * 0.85)));
      let processedCount = 0;
      let successCount = 0;
      showDeleteProgress("Deleting images 0/0", 0);
      setProgressCancelableAction("delete-images");
      let failed = [];
      let canceledByUser = false;
      const isCanceled = () => isProgressCancelRequested("delete-images");
      let targets = { canceled: false, imageIds: [], childVideoIds: [] };
      try {
        targets = await collectAllImageDeleteTargets(isCanceled);
      } catch (error) {
        endDeleteAllRun("images");
        setStatus("Delete images failed.");
        showToast("Delete images failed.", "error");
        hideDownloadProgress(0);
        updateActionButtons();
        return;
      }
      if (targets.canceled) canceledByUser = true;
      const toDelete = targets && targets.imageIds ? targets.imageIds : [];
      const childIds = targets && targets.childVideoIds ? targets.childVideoIds : [];
      const totalCount = toDelete.length;
      const totalSafe = Math.max(1, totalCount);
      showDeleteProgress(`Deleting images 0/${totalCount}`, 0);
      if (!canceledByUser && childIds.length) {
        await runPool(
          childIds,
          childSyncConcurrency,
          async (childId) => {
            if (!childId || isCanceled()) return;
            let res = null;
            try {
              res = await likePost(childId);
            } catch (error) {
              res = { ok: false, status: 0 };
            }
            if (!res || !res.ok) {
              const statusCode = Number((res && res.status) || 0);
              const ignoredBecauseParallel = isDeleteAllRunning("videos");
              const ignoredAlreadyGone = statusCode === 404 || statusCode === 410;
              if (!ignoredBecauseParallel && !ignoredAlreadyGone) {
                await sleep(30);
              }
            }
          },
          isCanceled
        );
        if (isCanceled()) canceledByUser = true;
      }
      if (!canceledByUser && toDelete.length) {
        await runPool(
          toDelete,
          deleteConcurrency,
          async (postId) => {
            if (!postId || isCanceled()) return;
            const result = await deletePostWithRetry(postId, 2);
            processedCount += 1;
            if (result && result.ok) {
              successCount += 1;
              animateThumbRemoval(postId);
            } else {
              failed.push(postId);
            }
            showDeleteProgress(`Deleting images ${processedCount}/${totalCount}`, processedCount / totalSafe);
          },
          isCanceled
        );
        if (isCanceled()) canceledByUser = true;
      }
      if (!canceledByUser && failed.length) {
        const retryIds = failed.slice();
        failed = [];
        await runPool(
          retryIds,
          Math.max(2, Math.min(6, Math.floor(deleteConcurrency / 2))),
          async (postId) => {
            if (!postId || isCanceled()) return;
            const result = await deletePostWithRetry(postId, 1);
            if (result && result.ok) {
              successCount += 1;
              animateThumbRemoval(postId);
              return;
            }
            failed.push(postId);
          },
          isCanceled
        );
        if (isCanceled()) canceledByUser = true;
      }
      if (canceledByUser) {
        endDeleteAllRun("images");
        setStatus("Deletion stopped.");
        showToast("Deletion stopped.");
        hideDownloadProgress(0);
        updateActionButtons();
        return;
      }
      if (toDelete.length) {
        updateItems();
      }
      endDeleteAllRun("images");
      setStatus(
        failed.length
          ? `Failed ${failed.length} deletions.`
          : toDelete.length
          ? "All deletions requested."
          : "No images to delete."
      );
      if (failed.length) {
        showToast("Some deletions failed.", "error");
        hideDownloadProgress(0);
      } else if (toDelete.length || successCount) {
        showDeleteDone("All your images have been removed");
      } else {
        hideDownloadProgress(0);
      }
      failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
      if (!failed.length) {
        if (!isAnyDeleteAllRunning()) {
          setStatus("Purging cache...");
          setTimeout(() => {
            purgeCache({ confirm: false, reload: true, silent: true });
          }, 2100);
          return;
        }
        pendingPurgeAfterDelete = true;
      }
      updateActionButtons();
      return;
    }
    if (isDeleteAllRunning("videos")) return;
    if (state.busy && !isBusyFromDeleteOnly()) return;
    if (!window.confirm("Do you want to delete all videos?")) return;
    beginDeleteAllRun("videos");
    updateActionButtons();
    setStatus("Deleting all videos...");
    const totalIds = new Set();
    const allIds = [];
    let cursor = undefined;
    let safety = 0;
    while (true) {
      const data = await fetchPage(cursor);
      const posts = data && data.posts ? data.posts : [];
      const extracted = extractItems(posts);
      const videos = dedupeItems(extracted.videos || []);
      for (let i = 0; i < videos.length; i += 1) {
        const id = videos[i] && videos[i].postId ? videos[i].postId : "";
        if (!id || totalIds.has(id)) continue;
        totalIds.add(id);
        allIds.push(id);
      }
      const nextCursor = data && data.nextCursor ? data.nextCursor : undefined;
      if (!nextCursor) break;
      cursor = nextCursor;
      safety += 1;
      if (safety > 200) break;
    }
    const totalCount = Math.max(1, totalIds.size);
    let deletedCount = 0;
    showDeleteProgress(`Deleting videos ${deletedCount}/${totalCount}`, 0);
    const failed = [];
    for (let i = 0; i < allIds.length; i += 1) {
      const id = allIds[i];
      setThumbStatus(id, "deleting", "Deleting...");
      const result = await deletePost(id);
      if (!result.ok) {
        failed.push(id);
      } else {
        animateThumbRemoval(id);
      }
      deletedCount += 1;
      showDeleteProgress(`Deleting videos ${deletedCount}/${totalCount}`, deletedCount / totalCount);
      await sleep(180);
    }
    resetModeState("videos");
    await ensurePageData("videos", 0);
    endDeleteAllRun("videos");
    setStatus(failed.length ? `Failed ${failed.length} deletions.` : "All deletions requested.");
    if (failed.length) {
      showToast("Some deletions failed.", "error");
      hideDownloadProgress(0);
    } else {
      showDeleteDone("All your videos have been removed");
    }
    failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
    if (!isAnyDeleteAllRunning() && pendingPurgeAfterDelete) {
      pendingPurgeAfterDelete = false;
      setStatus("Purging cache...");
      setTimeout(() => {
        purgeCache({ confirm: false, reload: true, silent: true });
      }, 2100);
      return;
    }
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

  const fetchBinaryViaExtension = (url, timeoutMs) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "grokViewerFetchBinary", url, timeoutMs: Number(timeoutMs) || 60000 },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "no-response" });
        }
      );
    });

  const fetchWithTimeout = async (url, timeoutMs) => {
    if (!url) throw new Error("missing-url");
    const targetUrl = normalizeUrl(url || "");
    if (!targetUrl) throw new Error("missing-url");
    let targetOrigin = "";
    try {
      targetOrigin = new URL(targetUrl, window.location.href).origin;
    } catch (error) {
      targetOrigin = "";
    }
    const isCrossOrigin = Boolean(targetOrigin && targetOrigin !== window.location.origin);
    if (isCrossOrigin) {
      const proxied = await fetchBinaryViaExtension(targetUrl, timeoutMs);
      if (proxied && proxied.ok) {
        let buffer = proxied.buffer;
        if ((!buffer || !(buffer instanceof ArrayBuffer)) && proxied.base64) {
          try {
            const binary = atob(String(proxied.base64 || ""));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
              bytes[i] = binary.charCodeAt(i) & 0xff;
            }
            buffer = bytes.buffer;
          } catch (error) {
            buffer = null;
          }
        }
        if (buffer && !(buffer instanceof ArrayBuffer) && ArrayBuffer.isView(buffer)) {
          buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        } else if (Array.isArray(buffer)) {
          buffer = Uint8Array.from(buffer).buffer;
        }
        if (buffer instanceof ArrayBuffer) {
          return new Response(buffer, {
            status: Number(proxied.status || 200) || 200,
            headers: { "content-type": String(proxied.contentType || "application/octet-stream") }
          });
        }
      }
      const errorText = String((proxied && proxied.error) || "fetch-failed");
      const statusCode = Number((proxied && proxied.status) || 0);
      const error = new Error(statusCode ? `${errorText} status=${statusCode}` : errorText);
      if (statusCode) error.status = statusCode;
      throw error;
    }

    let directResponse = null;
    let directError = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      directResponse = await fetch(targetUrl, {
        credentials: "include",
        signal: controller.signal
      });
    } catch (error) {
      directError = error;
    } finally {
      clearTimeout(timer);
    }

    if (directResponse) return directResponse;
    throw directError || new Error("fetch-failed");
  };

  const downloadViaExtension = (url, filename, saveAs) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "grokViewerDownloadUrl",
          url,
          filename,
          saveAs: !!saveAs,
          mode: getDownloadMode(),
          folderPath: sanitizeFolderPath(state.settings && state.settings.folderPath ? state.settings.folderPath : "")
        },
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

  const downloadBlobDirect = async (blob, filename) => {
    try {
      const targetFilename = resolveDownloadFilename(filename);
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = targetFilename;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      const host = document.body || document.documentElement;
      if (!host) throw new Error("missing-document-host");
      host.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        try {
          anchor.remove();
        } catch (error) {}
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (error) {}
      }, 12000);
      return { ok: true, filename: targetFilename, direct: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error || "blob-download-failed") };
    }
  };

  const downloadBlobViaExtension = async (blob, filename) => {
    if (getDownloadMode() === "folder_once") {
      const local = await writeBlobToChosenFolder(blob, filename);
      if (local && local.ok) return local;
    }
    const blobUrl = URL.createObjectURL(blob);
    const targetFilename = resolveDownloadFilename(filename);
    const result = await downloadViaExtension(blobUrl, targetFilename, resolveSaveAs());
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    return { ...(result || {}), filename: targetFilename };
  };

  const buildDownloadCandidates = (item) => {
    if (!item) return [];
    const urls = [];
    const seen = new Set();
    const videoProbe = normalizeUrl(
      (item && (item.playbackUrl || item.mediaUrl || item.url || item.hdMediaUrl)) || ""
    );
    const isVideoItem = isMp4(videoProbe, item && item.mimeType);
    const addUrl = (url) => {
      const normalized = normalizeUrl(url || "");
      if (!normalized) return;
      const optimized = optimizeThumbUrl(normalized);
      const variants = optimized && optimized !== normalized ? [optimized, normalized] : [normalized];
      for (let i = 0; i < variants.length; i += 1) {
        const candidate = String(variants[i] || "").trim();
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        urls.push(candidate);
      }
    };

    const postId = String((item && item.postId) || "").trim();
    const preferredMp4Ids = [];
    const isUuidLike = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    addUrl(pickDownloadUrl(item));
    addUrl(item && item.url ? item.url : "");
    addUrl(item && item.playbackUrl ? item.playbackUrl : "");
    addUrl(item && item.mediaUrl ? item.mediaUrl : "");
    addUrl(item && item.hdMediaUrl ? item.hdMediaUrl : "");
    if (isVideoItem) {
      if (isUuidLike(postId)) preferredMp4Ids.push(postId);
      const rawPrimary = [item.hdMediaUrl, item.playbackUrl, item.mediaUrl, item.url]
        .map((value) => normalizeUrl(value || ""))
        .filter(Boolean);
      for (let i = 0; i < rawPrimary.length; i += 1) {
        const extracted = extractMp4Id(rawPrimary[i]);
        if (extracted && !preferredMp4Ids.includes(extracted)) preferredMp4Ids.push(extracted);
      }
      for (let i = 0; i < preferredMp4Ids.length; i += 1) {
        const id = preferredMp4Ids[i];
        addUrl(`https://imagine-public.x.ai/imagine-public/share-videos/${id}.mp4?cache=1`);
        addUrl(`https://imagine-public.x.ai/imagine-public/share-videos/${id}.mp4`);
      }
    }
    return urls;
  };

  const mergeDownloadItemFields = (targetItem, freshItem) => {
    if (!targetItem || !freshItem) return;
    const keys = [
      "url",
      "hdMediaUrl",
      "mediaUrl",
      "playbackUrl",
      "poster",
      "sourceImageUrl",
      "mimeType",
      "mediaWidth",
      "mediaHeight",
      "isPortrait"
    ];
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (freshItem[key] !== undefined && freshItem[key] !== null && freshItem[key] !== "") {
        targetItem[key] = freshItem[key];
      }
    }
  };

  const resolveFreshDownloadItem = (detail, originalItem) => {
    if (!detail || !originalItem) return null;
    const postId = String(originalItem.postId || "").trim();
    const extracted = extractItems([detail]);
    const videos = (extracted && extracted.videos) || [];
    const images = (extracted && extracted.images) || [];
    let fresh =
      videos.find((entry) => String((entry && entry.postId) || "").trim() === postId) ||
      images.find((entry) => String((entry && entry.postId) || "").trim() === postId) ||
      null;
    if (!fresh && detail && String(detail.id || "").trim() === postId) {
      fresh =
        buildItem(
          detail,
          originalItem.parentPostId || "",
          originalItem.sourceImageUrl || "",
          originalItem.promptText || ""
        ) || buildImageItem(detail);
    }
    return fresh || null;
  };

  const buildFreshDownloadCandidatesForItem = async (item) => {
    const postId = String((item && item.postId) || "").trim();
    if (!postId) return [];
    try {
      const detail = await fetchPostDetails(postId);
      const freshItem = resolveFreshDownloadItem(detail, item);
      if (!freshItem) return [];
      mergeDownloadItemFields(item, freshItem);
      return buildDownloadCandidates(item);
    } catch (error) {
      return [];
    }
  };

  const resolveMediaDownloadFilename = (item) => {
    const targetItem = resolveActiveItem(item) || item;
    if (!targetItem) return "grok-media.bin";
    const candidates = buildDownloadCandidates(targetItem);
    const targetUrl = candidates[0] || targetItem.url || "";
    const baseUrl = String(targetUrl || "").split(/[?#]/)[0];
    const extMatch = baseUrl.match(/\.([a-z0-9]{2,6})$/i);
    const fallbackExt = isImage(targetItem.url, targetItem.mimeType) ? "jpg" : "mp4";
    const ext = extMatch ? extMatch[1].toLowerCase() : fallbackExt;
    const filenameBase = targetItem.postId || targetItem.id || "grok-media";
    return `${filenameBase}.${ext}`;
  };

  const getCreatedAtText = (item) => {
    const target = resolveActiveItem(item) || item;
    const stamp = toTime(target && target.createdAt ? target.createdAt : "");
    if (!stamp) return "Unknown";
    try {
      return new Date(stamp).toISOString();
    } catch (error) {
      return "Unknown";
    }
  };

  const buildPromptInfoFilename = (mediaFilename) => {
    const parts = splitNameExt(mediaFilename || "grok-media.mp4");
    const base = parts.base || "grok-media";
    return `${base}-prompt-info.txt`;
  };

  const buildPromptInfoContent = (item, promptText, mediaFilename) => {
    const lines = [];
    lines.push(`Title: ${mediaFilename || "Unknown"}`);
    lines.push(`Created at: ${getCreatedAtText(item)}`);
    lines.push("");
    lines.push("Original prompt:");
    lines.push(promptText || "");
    return `${lines.join("\n")}\n`;
  };

  const extractAskEachFolderPathFromFilename = (filename) => {
    const normalized = String(filename || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (!normalized) return "";
    const parts = normalized
      .replace(/^[a-z]:/i, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return "";
    const downloadsIdx = parts.findIndex((part) => String(part).toLowerCase() === "downloads");
    if (downloadsIdx >= 0) {
      const relative = parts.slice(downloadsIdx + 1, -1).join("/");
      return sanitizeFolderPath(relative);
    }
    return sanitizeFolderPath(parts[parts.length - 2] || "");
  };

  const rememberAskEachFolderFromDownloadOutcome = (outcome, requestedFilename) => {
    if (getDownloadMode() !== "ask_each") return;
    let folderPath = "";
    if (outcome && outcome.status && outcome.status.filename) {
      folderPath = extractAskEachFolderPathFromFilename(outcome.status.filename);
    }
    if (!folderPath) {
      const fallback = String(requestedFilename || "").replace(/\\/g, "/");
      const chunks = fallback.split("/").filter(Boolean);
      if (chunks.length > 1) {
        folderPath = sanitizeFolderPath(chunks.slice(0, -1).join("/"));
      }
    }
    const current = getAskEachFolderPath();
    if (current) return;
    if (!folderPath || folderPath === current) return;
    state.settings.askEachFolderPath = folderPath;
    persistSettings();
  };

  const downloadPromptInfoFile = async (item) => {
    const prompt = getPromptTextForItem(item);
    if (!prompt) {
      showToast("Prompt unavailable", "error");
      return;
    }
    const ready = await ensureFolderModeReady();
    if (!ready) return;
    const mediaFilename = resolveMediaDownloadFilename(item);
    const infoFilename = buildPromptInfoFilename(mediaFilename);
    const content = buildPromptInfoContent(item, prompt, mediaFilename);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const started = await downloadBlobViaExtension(blob, infoFilename);
    if (!started || !started.ok) {
      if (isDownloadCanceled(started)) {
        maybePromptDownloadSetupGuide();
        setReadyStatus();
        return;
      }
      setStatus("Prompt info download failed.");
      return;
    }
    const saveAs = resolveSaveAs();
    const effectiveName = started.filename || resolveDownloadFilename(infoFilename);
    const promptVerify = await verifyDownloadResult(started, saveAs ? 120000 : 1800, !!saveAs);
    if (!promptVerify.ok) {
      if (promptVerify.state === "canceled") {
        maybePromptDownloadSetupGuide();
        setReadyStatus();
        return;
      }
      setStatus("Prompt info download failed.");
      return;
    }
    if (saveAs && promptVerify.outcome) {
      rememberAskEachFolderFromDownloadOutcome(promptVerify.outcome, effectiveName);
    }
    showDownloadReady("Your prompt file is ready. Click here", effectiveName);
    if (!saveAs) await waitForDownloadWithTimeout(effectiveName, true, 20000);
  };

  const downloadFile = async (item) => {
    const targetItem = resolveActiveItem(item);
    if (!targetItem) return;
    try {
      const candidates = buildDownloadCandidates(targetItem);
      const targetUrl = candidates[0] || "";
      if (!targetUrl) {
        setStatus("Download failed.");
        return;
      }
      const filename = resolveMediaDownloadFilename(targetItem);
      const ready = await ensureFolderModeReady();
      if (!ready) return;
      const alreadyDownloaded = isItemDownloaded(state.mode, targetItem);
      if (alreadyDownloaded) {
        const again = window.confirm("This file has already been downloaded. Do you want to download it again?");
        if (!again) return;
      }

      if (getDownloadMode() === "folder_once") {
        for (let i = 0; i < candidates.length; i += 1) {
          let response = null;
          try {
            response = await fetchWithTimeout(candidates[i], 60000);
          } catch (error) {
            response = null;
          }
          if (!response || !response.ok) continue;
          const blob = await response.blob();
          const local = await writeBlobToChosenFolder(blob, filename);
          if (local && local.ok) {
            recordDownloadedItems(state.mode, [targetItem]);
            syncVisibleDownloadedBadges();
            showDownloadReady("Your file is ready. Click here", local.filename || filename);
            return;
          }
        }
        const targetFilename = resolveDownloadFilename(filename);
        for (let i = 0; i < candidates.length; i += 1) {
          const started = await downloadViaExtension(candidates[i], targetFilename, false);
          const verify = await verifyDownloadResult(started, 1800, false);
          if (verify.ok) {
            recordDownloadedItems(state.mode, [targetItem]);
            syncVisibleDownloadedBadges();
            showDownloadReady("Your file is ready. Click here", targetFilename);
            return;
          }
          if (verify.state === "canceled") {
            maybePromptDownloadSetupGuide();
            setReadyStatus();
            return;
          }
          if (isDownloadCanceled(started)) {
            maybePromptDownloadSetupGuide();
            setReadyStatus();
            return;
          }
        }
        setStatus("Download failed.");
        return;
      }

      const targetFilename = resolveDownloadFilename(filename);
      let saveAs = resolveSaveAs();
      if (alreadyDownloaded && getDownloadMode() === "ask_each") saveAs = true;
      let started = null;
      let verifiedOutcome = null;
      for (let i = 0; i < candidates.length; i += 1) {
        const startedAttempt = await downloadViaExtension(candidates[i], targetFilename, saveAs);
        const verify = await verifyDownloadResult(startedAttempt, saveAs ? 120000 : 1800, !!saveAs);
        if (verify.ok) {
          started = startedAttempt;
          verifiedOutcome = verify.outcome;
          break;
        }
        if (verify.state === "canceled") {
          maybePromptDownloadSetupGuide();
          setReadyStatus();
          return;
        }
        started = startedAttempt;
        if (isDownloadCanceled(started)) {
          maybePromptDownloadSetupGuide();
          setReadyStatus();
          return;
        }
      }
      if (!started || !started.ok) {
        setStatus("Download failed.");
        return;
      }
      if (saveAs && verifiedOutcome) {
        rememberAskEachFolderFromDownloadOutcome(verifiedOutcome, targetFilename);
      }
      recordDownloadedItems(state.mode, [targetItem]);
      syncVisibleDownloadedBadges();
      showDownloadReady("Your file is ready. Click here", targetFilename);
      if (!saveAs) await waitForDownloadWithTimeout(targetFilename, true, 20000);
    } catch (error) {
      setStatus("Download failed.");
    }
  };

  const downloadOne = () => {
    const item = state.items[state.selectedIndex];
    if (!item) return;
    downloadFile(item);
  };

  const downloadGroup = async () => {
    const group = state.items[state.selectedIndex];
    if (!group || !group.variants || group.variants.length <= 1 || state.busy) return;
    const ready = await ensureFolderModeReady();
    if (!ready) return;
    const isImages = state.mode === "images";
    state.busy = true;
    updateActionButtons();
    setStatus("Preparing compilation...");
    showDownloadProgress();
    if (downloadGroupBtn) {
      downloadGroupBtn.classList.add("done");
      setTimeout(() => {
        if (!downloadGroupBtn) return;
        downloadGroupBtn.classList.remove("done");
      }, 5000);
    }
    const run = async () => {
      let retryRequested = false;
      try {
        const items = group.variants.slice();
        const files = [];
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (!item) continue;
          let response = null;
          let candidates = buildDownloadCandidates(item);
          for (let c = 0; c < candidates.length; c += 1) {
            try {
              response = await fetchWithTimeout(candidates[c], 120000);
              if (response && response.ok) break;
            } catch (error) {
              response = null;
            }
          }
          if (!response || !response.ok) {
            const refreshedCandidates = await buildFreshDownloadCandidatesForItem(item);
            candidates = refreshedCandidates.length ? refreshedCandidates : candidates;
            for (let c = 0; c < candidates.length; c += 1) {
              try {
                response = await fetchWithTimeout(candidates[c], 120000);
                if (response && response.ok) break;
              } catch (error) {
                response = null;
              }
            }
          }
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
        const savePrompt = resolveSaveAs();
        let started = await downloadBlobViaExtension(blob, archiveName);
        let archiveVerify = await verifyDownloadResult(started, savePrompt ? 120000 : 15000, !!savePrompt);
        if (!archiveVerify.ok) {
          const directStarted = await downloadBlobDirect(blob, archiveName);
          if (directStarted && directStarted.ok) {
            started = directStarted;
            archiveVerify = { ok: true, state: "direct", outcome: null };
          }
        }
        if (!archiveVerify.ok) {
          retryRequested = await askArchiveRetry("Archive download interrupted. Do you want to retry?");
          if (!retryRequested) {
            setStatus("Download stopped.");
            if (archiveVerify.state === "canceled" || isDownloadCanceled(started)) maybePromptDownloadSetupGuide();
          }
          return;
        }
        if (savePrompt && archiveVerify.outcome) {
          rememberAskEachFolderFromDownloadOutcome(archiveVerify.outcome, started.filename || archiveName);
        }
        recordDownloadedItems(state.mode, items);
        renderGrid();
        const startText = "Starting download of archive 1...";
        setStatus(startText);
        setDownloadProgress(startText, 0);
        const effectiveName = started.filename || archiveName;
        showDownloadReady("Your file is ready. Click here", effectiveName);
        await waitForDownloadWithTimeout(effectiveName, true, 20000);
      } catch (error) {
        setStatus("Download failed.");
      } finally {
        state.busy = false;
        hideDownloadProgress(0);
        updateActionButtons();
        if (retryRequested) {
          setTimeout(() => {
            downloadGroup();
          }, 120);
        }
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

  const downloadAll = async () => {
    if (state.busy || !state.items.length) return;
    const ready = await ensureFolderModeReady();
    if (!ready) return;
    const isImages = state.mode === "images";
    addBulkDebug("downloadAll click", `mode=${state.mode} items=${state.items.length} target=${getBulkTarget()}`);
    state.busy = true;
    updateActionButtons();
    const mode = state.mode;
    const bulkTarget = getBulkTarget();
    const { fresh, dupCount, duplicates } = await collectBulkItems(mode, bulkTarget);
    addBulkDebug(
      "collectBulkItems",
      `mode=${mode} fresh=${fresh.length} dupCount=${dupCount} dupSample=${(duplicates && duplicates.length) || 0}`
    );
    if (dupCount) showDuplicateModal("Some files were already downloaded once, I’ll only download the new ones.");
    let selectedItems = fresh;
    if (!fresh.length && dupCount) {
      setStatus("All files already downloaded.");
      const redownload = await askDuplicateModal(
        "All your files have already been downloaded. Wanna download them again?",
        10
      );
      hideDuplicateModal();
      if (!redownload) {
        state.busy = false;
        hideDownloadProgress(0);
        updateActionButtons();
        return;
      }
      selectedItems = (duplicates || []).slice(0, Math.max(1, bulkTarget));
    }
    if (!selectedItems.length) {
      setStatus("All files already downloaded.");
      showDuplicateModal("All your files have already been downloaded. Wanna download them again?");
      state.busy = false;
      hideDownloadProgress(0);
      updateActionButtons();
      return;
    }
    const bulkCount = selectedItems.length;
    const bulkLabel = isImages
      ? `Download (${bulkCount}) images in bulk`
      : `Download (${bulkCount}) videos in bulk`;
    addBulkDebug("bulk selection", `bulkCount=${bulkCount} label="${bulkLabel}"`);
    setStatus(`${bulkLabel}...`);
    showDownloadProgress();
    const run = async () => {
      let readyShown = false;
      let retryRequested = false;
      let stoppedByUser = false;
      try {
        setProgressCancelableAction("bulk-download");
        const savePrompt = resolveSaveAs();
        const total = selectedItems.length;
        const fastBulk = state.settings && state.settings.fastBulk !== false;
        const batchSize = fastBulk
          ? total > 140
            ? 30
            : total > 90
            ? 25
            : total > 50
            ? 22
            : total
          : total > 80
          ? 15
          : total > 45
          ? 20
          : total;
        const batches = [];
        for (let i = 0; i < total; i += batchSize) {
          batches.push(selectedItems.slice(i, i + batchSize));
        }
        addBulkDebug(
          "bulk run start",
          `total=${total} batchSize=${batchSize} batches=${batches.length} savePrompt=${savePrompt ? "yes" : "no"}`
        );
        const baseTime = Date.now();
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          if (isProgressCancelRequested("bulk-download")) {
            stoppedByUser = true;
            addBulkDebug("cancel requested before batch", `batch=${batchIndex + 1}`);
            break;
          }
          const batch = batches[batchIndex];
          const files = [];
          const queue = batch.map((item) => ({ item, tries: 0, refreshed: false, candidates: buildDownloadCandidates(item) }));
          const cpu = navigator.hardwareConcurrency || 6;
          const baseConcurrency = fastBulk
            ? isImages
              ? Math.min(14, Math.max(6, cpu))
              : Math.min(16, Math.max(7, cpu + 1))
            : Math.min(6, Math.max(3, cpu));
          const concurrency = Math.min(baseConcurrency, batch.length || 1);
          let completed = 0;
          let failedCount = 0;
          addBulkDebug(
            "batch start",
            `batch=${batchIndex + 1}/${batches.length} items=${batch.length} concurrency=${concurrency}`
          );
          const batchHeartbeat = setInterval(() => {
            addBulkDebug(
              "batch heartbeat",
              `batch=${batchIndex + 1}/${batches.length} completed=${completed}/${batch.length} queue=${queue.length} failed=${failedCount}`
            );
          }, 5000);
          const fetchOne = async () => {
            while (queue.length) {
              if (isProgressCancelRequested("bulk-download")) return;
              const entry = queue.shift();
              if (!entry || !entry.item) continue;
              let response;
              const candidates =
                entry.candidates && entry.candidates.length ? entry.candidates.slice() : buildDownloadCandidates(entry.item);
              addBulkDebug(
                "item fetch start",
                `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} try=${entry.tries} candidates=${candidates.length}`
              );
              try {
                response = null;
                let lastFetchError = "";
                for (let c = 0; c < candidates.length; c += 1) {
                  const candidateUrl = candidates[c];
                  if (!candidateUrl) continue;
                  try {
                    const attempt = await fetchWithTimeout(candidateUrl, 120000);
                    if (attempt && attempt.ok) {
                      response = attempt;
                      addBulkDebug(
                        "item fetch ok",
                        `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} url=${candidateUrl}`
                      );
                      break;
                    }
                    addBulkDebug(
                      "item fetch non-ok",
                      `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} status=${
                        attempt ? attempt.status : 0
                      } url=${candidateUrl}`
                    );
                    lastFetchError = `HTTP ${attempt ? attempt.status : 0} ${candidateUrl}`;
                  } catch (error) {
                    lastFetchError = String((error && error.message) || error || "fetch-failed");
                    addBulkDebug(
                      "item fetch exception",
                      `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} url=${candidateUrl} error=${lastFetchError}`
                    );
                  }
                }
                if (!response || !response.ok) throw new Error(lastFetchError || `HTTP ${response ? response.status : 0}`);
              } catch (error) {
                addBulkDebug(
                  "item fetch failed",
                  `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} try=${entry.tries} error=${
                    (error && error.message) || error || "unknown"
                  }`
                );
                if (!entry.refreshed && entry.item && entry.item.postId) {
                  const refreshedCandidates = await buildFreshDownloadCandidatesForItem(entry.item);
                  if (refreshedCandidates.length) {
                    addBulkDebug(
                      "item refresh candidates",
                      `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} candidates=${refreshedCandidates.length}`
                    );
                    queue.push({
                      item: entry.item,
                      tries: entry.tries + 1,
                      refreshed: true,
                      candidates: refreshedCandidates
                    });
                    await sleep(20);
                    continue;
                  }
                }
                if (entry.tries < 2) {
                  addBulkDebug(
                    "item retry queued",
                    `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} nextTry=${entry.tries + 1}`
                  );
                  queue.push({
                    item: entry.item,
                    tries: entry.tries + 1,
                    refreshed: entry.refreshed,
                    candidates
                  });
                  await sleep(20);
                  continue;
                }
                failedCount += 1;
                setStatus(`${bulkLabel}...`);
                await sleep(20);
                continue;
              }
              const buffer = new Uint8Array(await response.arrayBuffer());
              const { dosTime, dosDate } = toDosTimeDate(new Date());
              const baseUrl = (entry.item.url || "").split(/[?#]/)[0];
              const extMatch = baseUrl.match(/\.([a-z0-9]{2,6})$/i);
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
              addBulkDebug(
                "item packaged",
                `batch=${batchIndex + 1} post=${entry.item.postId || entry.item.id || "n/a"} size=${buffer.length} completed=${completed}/${batch.length}`
              );
              const prepText = `${bulkLabel}...`;
              setStatus(prepText);
              setDownloadProgress(prepText, completed / batch.length);
              if (failedCount && failedCount % 6 === 0) await sleep(15);
            }
          };
          const workers = [];
          for (let i = 0; i < concurrency; i += 1) {
            workers.push(fetchOne());
          }
          try {
            await Promise.all(workers);
          } finally {
            clearInterval(batchHeartbeat);
          }
          addBulkDebug(
            "batch fetch complete",
            `batch=${batchIndex + 1}/${batches.length} files=${files.length} failed=${failedCount} remainingQueue=${queue.length}`
          );
          if (isProgressCancelRequested("bulk-download")) {
            stoppedByUser = true;
            addBulkDebug("cancel requested after fetch", `batch=${batchIndex + 1}`);
            break;
          }
          if (!files.length) continue;
          const buildText = `${bulkLabel}...`;
          setStatus(buildText);
          setDownloadProgress(buildText, 1);
          addBulkDebug("zip build start", `batch=${batchIndex + 1} files=${files.length}`);
          const blob = buildZipBlob(files);
          addBulkDebug("zip build done", `batch=${batchIndex + 1} blobSize=${blob.size}`);
          const prefix = isImages ? "grok-images" : "grok-videos";
          const archiveName =
            batches.length > 1
              ? `${prefix}-${baseTime}-part-${batchIndex + 1}.zip`
              : `${prefix}-${baseTime}.zip`;
          let started = await downloadBlobViaExtension(blob, archiveName);
          addBulkDebug(
            "archive start via extension",
            `batch=${batchIndex + 1} ok=${started && started.ok ? "yes" : "no"} id=${
              started && started.downloadId ? started.downloadId : 0
            }`
          );
          let archiveVerify = await verifyDownloadResult(started, savePrompt ? 120000 : 15000, !!savePrompt);
          addBulkDebug(
            "archive verify",
            `batch=${batchIndex + 1} ok=${archiveVerify.ok ? "yes" : "no"} state=${archiveVerify.state || "n/a"}`
          );
          if (!archiveVerify.ok) {
            const directStarted = await downloadBlobDirect(blob, archiveName);
            if (directStarted && directStarted.ok) {
              started = directStarted;
              archiveVerify = { ok: true, state: "direct", outcome: null };
              addBulkDebug("archive direct fallback", `batch=${batchIndex + 1} ok=yes`);
            } else {
              addBulkDebug(
                "archive direct fallback",
                `batch=${batchIndex + 1} ok=no error=${(directStarted && directStarted.error) || "unknown"}`
              );
            }
          }
          if (!archiveVerify.ok) {
            addBulkDebug(
              "archive failed",
              `batch=${batchIndex + 1} state=${archiveVerify.state || "n/a"} asking-retry=yes`
            );
            retryRequested = await askArchiveRetry("Archive download interrupted. Do you want to retry?");
            if (!retryRequested) {
              stoppedByUser = true;
              if (archiveVerify.state === "canceled" || isDownloadCanceled(started)) maybePromptDownloadSetupGuide();
            }
            break;
          }
          if (savePrompt && archiveVerify.outcome) {
            rememberAskEachFolderFromDownloadOutcome(archiveVerify.outcome, started.filename || archiveName);
          }
          recordDownloadedItems(state.mode, batch);
          renderGrid();
          const startText = `Downloading ${batchIndex + 1}/${batches.length} archive`;
          setStatus(startText);
          setDownloadProgress(startText, Math.min(1, (batchIndex + 1) / Math.max(1, batches.length)));
          const effectiveName = started.filename || archiveName;
          addBulkDebug("archive complete", `batch=${batchIndex + 1} filename=${effectiveName}`);
          if (batchIndex < batches.length - 1) {
            hideDownloadProgress(0);
            showDownloadProgress();
            setProgressCancelableAction("bulk-download");
            setStatus(`${bulkLabel}...`);
            setDownloadProgress(`${bulkLabel}...`, Math.min(1, (batchIndex + 1) / Math.max(1, batches.length)));
          }
          if (batchIndex === batches.length - 1) {
            hideDownloadProgress(0);
            showDownloadReady("Your file is ready. Click here", effectiveName);
            readyShown = true;
          }
          if (batchIndex < batches.length - 1) await sleep(15);
        }
        if (stoppedByUser) {
          setStatus("Download stopped.");
          showToast("Download stopped.");
          addBulkDebug("bulk run stop", "stoppedByUser=yes");
        } else if (!readyShown && !retryRequested) {
          setReadyStatus();
          addBulkDebug("bulk run end", "readyShown=no retry=no setReadyStatus");
        }
      } catch (error) {
        setStatus("Download all failed.");
        addBulkDebug("bulk run exception", String((error && error.message) || error || "unknown"));
      } finally {
        hideDuplicateModal();
        state.busy = false;
        hideDownloadProgress(0);
        updateActionButtons();
        addBulkDebug("bulk run finally", `retryRequested=${retryRequested ? "yes" : "no"} stopped=${stoppedByUser ? "yes" : "no"}`);
        if (retryRequested) {
          setTimeout(() => {
            downloadAll();
          }, 120);
        }
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
  let regenCreatedAudio;
  let regenCreatedNoticeEl;
  let regenCreatedTimer = null;
  let promptCopyAudio;
  let promptErrorAudio;
  let downloadClickAudio;
  let shareClickAudio;
  let closeClickAudio;
  let downloadProgressEl;
  let downloadProgressText;
  let downloadProgressFill;
  let progressStopBtn;
  let githubBtn;
  let deleteDoneEl;
  let deleteDoneTimer = null;
  let changelogModal;
  let changelogClose;
  let changelogGithub;
  let settingsModal;
  let settingsClose;
  let settingsBtn;
  let dlModeAsk;
  let dlModeFolder;
  let dlModeAuto;
  let dlModeFolderRow;
  let folderHintEl;
  let changeFolderBtn;
  let bulk32Btn;
  let bulk64Btn;
  let bulk120Btn;
  let autoRefreshAlwaysCheck;
  let autoRefreshTimer = null;
  let duplicateModal;
  let duplicateClose;
  let duplicateMessageEl;
  let duplicateTimerEl;
  let duplicateYesBtn;
  let duplicateNoBtn;
  let duplicateTimerHandle = null;
  let duplicateIntervalHandle = null;
  let duplicateAskResolver = null;
  let duplicateAskActive = false;
  let duplicateModalPreviousFocus = null;
  let promptChoiceModal;
  let promptChoiceClose;
  let promptChoiceCopyBtn;
  let promptChoiceDownloadBtn;
  let promptChoiceAskResolver = null;
  let promptChoiceTimer = null;
  let promptChoiceModalPreviousFocus = null;
  let lightboxPromptNoticeTimer = null;
  const thumbPromptNoticeTimers = new WeakMap();
  let nestedGuideModal;
  let nestedGuideOkBtn;
  let nestedGuideDontRemind;
  let normalGuideModal;
  let normalGuideOkBtn;
  let normalGuideDontRemind;
  let floatingTooltip;
  let viewModeModal;
  let viewModeModalPreviousFocus = null;
  let modeGridBtn;
  let modeNormalBtn;
  let modeDownloadSettingsBtn;
  let modeSetupDoneDot;
  let modeDontRemind;
  let appEl;
  let brandTitleEl;
  let viewModeBtn;
  let viewModeIcon;
  let viewModeLabel;
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
  let promptBtn;
  let regenBtn;
  let autoNextBtn;
  let downloadGroupBtn;
  let autoAllBtn;
  let prevBtn;
  let nextBtn;
  let playerEl;
  let regenOverlayEl;
  let regenProgressTextEl;
  let regenProgressFillEl;
  let regenStopBtn;
  let regenNoticeEl;
  let regenNoticeTextEl;
  let regenNoticeCloseBtn;
  let regenDebugEl;
  let regenDebugBodyEl;
  let variantWrapEl;
  let variantStripEl;
  let variantMoreBtn;
  let imageEl;
  let clearPlayerLoadHooks = null;
  let playerLoadToken = 0;
  let toastEl;
  let toastText;
  let hideModToastWrap;
  const progressControl = { action: "", requested: false };
  const regenState = {
    cooldownUntil: 0,
    jobs: new Map(),
    activePostId: "",
    lastJobAt: 0
  };
  const newGenerationHighlightIds = new Set();
  const hydratedNewVideoPosts = new Set();
  let regenNoticeTimer = null;
  let regenCooldownTimer = null;
  let pendingPurgeAfterDelete = false;

  const updateCount = () => {
    const modeState = getModeState(state.mode);
    const total = modeState.totalLoaded || state.items.length;
    if (countEl) {
      const label = state.mode === "images" ? "image" : "video";
      countEl.textContent = `Loaded ${total} ${label}${total === 1 ? "" : "s"}`;
    }
    if (statusEl) {
      const current = (statusEl.textContent || "").trim();
      if (!current || /^Ready\\b/i.test(current) || /^Press Refresh\\b/i.test(current) || /^Loaded\\b/i.test(current)) {
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
    return `Loaded ${total} ${label}`;
  };

  const setReadyStatus = () => {
    if (statusEl) statusEl.textContent = getReadyStatus();
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const isRegenCreatedNoticeVisible = () =>
    Boolean(regenCreatedNoticeEl && regenCreatedNoticeEl.classList.contains("show"));

  const hideRegenCreatedNotice = () => {
    if (regenCreatedTimer) {
      clearTimeout(regenCreatedTimer);
      regenCreatedTimer = null;
    }
    if (regenCreatedNoticeEl) regenCreatedNoticeEl.classList.remove("show");
    const progressVisible = downloadProgressEl && downloadProgressEl.classList.contains("show");
    const doneVisible = deleteDoneEl && deleteDoneEl.classList.contains("show");
    const toastVisible = toastEl && toastEl.classList.contains("show");
    if (githubBtn && !progressVisible && !doneVisible && !toastVisible) {
      githubBtn.classList.remove("hidden");
    }
  };

  const showRegenCreatedNotice = () => {
    if (!regenCreatedNoticeEl) return;
    if (regenCreatedTimer) {
      clearTimeout(regenCreatedTimer);
      regenCreatedTimer = null;
    }
    regenCreatedNoticeEl.textContent = "New generation created!";
    regenCreatedNoticeEl.classList.add("show");
    if (githubBtn) githubBtn.classList.add("hidden");
    if (regenCreatedAudio) {
      try {
        regenCreatedAudio.currentTime = 0;
        const playPromise = regenCreatedAudio.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      } catch (e) {}
    }
    regenCreatedTimer = setTimeout(() => {
      hideRegenCreatedNotice();
    }, 4000);
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

  const openDownloadSettingsPage = () =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerOpenDownloadSettingsAndReopen" }, (response) => {
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

  const getDownloadById = (downloadId) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "grokViewerGetDownloadById", downloadId }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });

  const waitForDownloadIdOutcome = async (downloadId, timeoutMs) => {
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 120000);
    let seenRecord = false;
    while (Date.now() < deadline) {
      const status = await getDownloadById(downloadId);
      if (status && status.ok) {
        seenRecord = true;
        const stateName = String(status.state || "").toLowerCase();
        const errName = String(status.error || "").toLowerCase();
        if (stateName === "complete") return { ok: true, state: "complete", status };
        if (stateName === "interrupted") {
          if (errName.includes("cancel")) return { ok: true, state: "canceled", status };
          return { ok: true, state: "interrupted", status };
        }
      }
      await sleep(250);
    }
    return { ok: false, state: seenRecord ? "pending" : "not-found" };
  };

  const verifyDownloadResult = async (started, timeoutMs, requireComplete) => {
    if (!started || !started.ok) return { ok: false, state: "failed", outcome: null };
    const downloadId = Number((started && started.downloadId) || 0);
    if (!downloadId) return { ok: true, state: "unknown", outcome: null };
    const outcome = await waitForDownloadIdOutcome(downloadId, timeoutMs);
    const stateName = String((outcome && outcome.state) || "").toLowerCase();
    if (stateName === "complete") return { ok: true, state: "complete", outcome: outcome || null };
    if (stateName === "pending") {
      if (requireComplete) return { ok: false, state: "timeout", outcome: null };
      return { ok: true, state: "pending", outcome: null };
    }
    if (stateName === "not-found") return { ok: false, state: "not-found", outcome: null };
    if (stateName === "canceled") return { ok: false, state: "canceled", outcome: outcome || null };
    if (stateName === "interrupted") return { ok: false, state: "interrupted", outcome: outcome || null };
    if (requireComplete) return { ok: false, state: stateName || "failed", outcome: null };
    return { ok: true, state: "pending", outcome: null };
  };

  const waitForDownloadWithTimeout = async (filename, requireComplete, timeoutMs) => {
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : 45000;
    const result = await Promise.race([
      waitForDownload(filename, requireComplete),
      sleep(limit).then(() => ({ ok: false, timeout: true }))
    ]);
    return result || { ok: false };
  };

  const setProgressCancelableAction = (action) => {
    progressControl.action = action || "";
    progressControl.requested = false;
    if (!progressStopBtn) return;
    if (!progressControl.action) {
      progressStopBtn.style.display = "none";
      progressStopBtn.disabled = false;
      return;
    }
    progressStopBtn.style.display = "inline-flex";
    progressStopBtn.disabled = false;
  };

  const requestProgressCancel = () => {
    if (!progressControl.action) return;
    progressControl.requested = true;
    if (progressStopBtn) progressStopBtn.disabled = true;
  };

  const isProgressCancelRequested = (action) =>
    Boolean(progressControl.requested && progressControl.action && (!action || progressControl.action === action));

  const askArchiveRetry = async (message) => {
    hideDuplicateModal();
    const retry = await askDuplicateModal(
      message || "Archive download was interrupted. Do you want to retry?",
      15
    );
    hideDuplicateModal();
    return retry;
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
      setProgressCancelableAction("");
      if (downloadProgressEl) downloadProgressEl.classList.remove("show");
      const readyVisible = downloadReadyEl && downloadReadyEl.style.display === "inline-flex";
      const toastVisible = toastEl && toastEl.classList.contains("show");
      const regenCreatedVisible = isRegenCreatedNoticeVisible();
      if (githubBtn && !readyVisible && !toastVisible && !regenCreatedVisible) githubBtn.classList.remove("hidden");
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
    setProgressCancelableAction("");
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
        if (githubBtn && !isRegenCreatedNoticeVisible()) githubBtn.classList.remove("hidden");
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
      const regenCreatedVisible = isRegenCreatedNoticeVisible();
      if (githubBtn && !progressVisible && !doneVisible && !regenCreatedVisible) githubBtn.classList.remove("hidden");
    }, 1600);
  };

  const clearLightboxPromptInlineNotice = () => {
    const actionsEl = lightboxEl ? lightboxEl.querySelector(".lightbox-actions") : null;
    if (!actionsEl) return;
    if (lightboxPromptNoticeTimer) {
      clearTimeout(lightboxPromptNoticeTimer);
      lightboxPromptNoticeTimer = null;
    }
    actionsEl.classList.remove("prompt-inline-active");
    const notice = actionsEl.querySelector(".prompt-inline-notice");
    if (notice) {
      notice.classList.remove("error");
      notice.textContent = "";
    }
  };

  const showLightboxPromptInlineNotice = (message, type) => {
    const actionsEl = lightboxEl ? lightboxEl.querySelector(".lightbox-actions") : null;
    if (!actionsEl) return false;
    let notice = actionsEl.querySelector(".prompt-inline-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "prompt-inline-notice";
      actionsEl.appendChild(notice);
    }
    notice.textContent = String(message || "").trim();
    notice.classList.toggle("error", type === "error");
    actionsEl.classList.add("prompt-inline-active");
    if (lightboxPromptNoticeTimer) clearTimeout(lightboxPromptNoticeTimer);
    lightboxPromptNoticeTimer = setTimeout(() => {
      clearLightboxPromptInlineNotice();
    }, 4000);
    return true;
  };

  const clearThumbPromptInlineNotice = (thumb) => {
    if (!thumb) return;
    const timer = thumbPromptNoticeTimers.get(thumb);
    if (timer) {
      clearTimeout(timer);
      thumbPromptNoticeTimers.delete(thumb);
    }
    thumb.classList.remove("prompt-inline-active");
    const notice = thumb.querySelector(".thumb-inline-notice");
    if (notice) {
      notice.classList.remove("error");
      notice.textContent = "";
    }
  };

  const showThumbPromptInlineNotice = (thumb, message, type) => {
    if (!thumb) return false;
    const overlay = thumb.querySelector(".thumb-overlay");
    if (!overlay) return false;
    let notice = overlay.querySelector(".thumb-inline-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "thumb-inline-notice";
      overlay.appendChild(notice);
    }
    notice.textContent = String(message || "").trim();
    notice.classList.toggle("error", type === "error");
    thumb.classList.add("prompt-inline-active");
    const oldTimer = thumbPromptNoticeTimers.get(thumb);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(() => {
      clearThumbPromptInlineNotice(thumb);
    }, 4000);
    thumbPromptNoticeTimers.set(thumb, timer);
    return true;
  };

  const showPromptInlineFeedback = (message, type, context = {}) => {
    const safeMessage = String(message || "").trim();
    if (!safeMessage) return;
    const source = String((context && context.source) || "").toLowerCase();
    const trigger = context && context.trigger ? context.trigger : null;
    if (source === "lightbox") {
      if (showLightboxPromptInlineNotice(safeMessage, type)) return;
    }
    if (source === "thumb") {
      const thumb = context && context.thumbEl ? context.thumbEl : trigger && trigger.closest ? trigger.closest(".thumb") : null;
      if (showThumbPromptInlineNotice(thumb, safeMessage, type)) return;
    }
    if (showToast) showToast(safeMessage, type);
  };

  const getSelectedRegenPostId = () => {
    const selected = state.items[state.selectedIndex];
    const active = resolveActiveItem(selected);
    return active && active.postId ? String(active.postId).trim() : "";
  };

  const getActiveRegenPostId = () => {
    const selectedPostId = getSelectedRegenPostId();
    if (selectedPostId) {
      regenState.activePostId = selectedPostId;
      return selectedPostId;
    }
    return String(regenState.activePostId || "").trim();
  };

  const getRegenJob = (postId) => {
    const key = String(postId || "").trim();
    if (!key) return null;
    return regenState.jobs.get(key) || null;
  };

  const getOrCreateRegenJob = (postId) => {
    const key = String(postId || "").trim();
    if (!key) return null;
    const existing = regenState.jobs.get(key);
    if (existing) return existing;
    const created = {
      postId: key,
      running: false,
      progress: 0,
      abortController: null,
      logs: []
    };
    regenState.jobs.set(key, created);
    return created;
  };

  const getRunningRegenCount = () => {
    let count = 0;
    regenState.jobs.forEach((job) => {
      if (job && job.running) count += 1;
    });
    return count;
  };

  const collectPostIdsForItem = (item) => {
    const ids = new Set();
    const add = (value) => {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    };
    if (!item) return ids;
    const active = resolveActiveItem(item) || item;
    add(active && active.postId);
    add(item.postId);
    if (item.variants && item.variants.length) {
      for (let i = 0; i < item.variants.length; i += 1) {
        add(item.variants[i] && item.variants[i].postId);
      }
    }
    return ids;
  };

  const hasNewGenerationHighlight = (item, displayItem) => {
    const postId = String((displayItem && displayItem.postId) || "").trim();
    if (postId && newGenerationHighlightIds.has(postId)) return true;
    if (item && item.variants && item.variants.length) {
      for (let i = 0; i < item.variants.length; i += 1) {
        const id = String((item.variants[i] && item.variants[i].postId) || "").trim();
        if (id && newGenerationHighlightIds.has(id)) return true;
      }
    }
    return false;
  };

  const ensureThumbNewRibbon = (thumb) => {
    if (!thumb) return null;
    let ribbon = thumb.querySelector(".thumb-new-ribbon");
    if (!ribbon) {
      ribbon = document.createElement("span");
      ribbon.className = "thumb-new-ribbon";
      ribbon.textContent = "NEW";
      thumb.appendChild(ribbon);
    }
    return ribbon;
  };

  const syncGridNewGenerationVisuals = () => {
    if (!gridEl) return;
    const thumbs = gridEl.querySelectorAll(".thumb[data-index]");
    for (let i = 0; i < thumbs.length; i += 1) {
      const thumb = thumbs[i];
      const index = Number(thumb.dataset.index || "-1");
      if (!Number.isFinite(index) || index < 0 || index >= state.items.length) continue;
      const item = state.items[index];
      const displayItem = resolveActiveItem(item) || item;
      const shouldHighlight = hasNewGenerationHighlight(item, displayItem);
      thumb.classList.toggle("new-generation", shouldHighlight);
      if (shouldHighlight) {
        ensureThumbNewRibbon(thumb);
      } else {
        const ribbon = thumb.querySelector(".thumb-new-ribbon");
        if (ribbon && ribbon.parentNode) ribbon.parentNode.removeChild(ribbon);
      }
    }
  };

  const markNewGenerationHighlight = (postId) => {
    const id = String(postId || "").trim();
    if (!id) return;
    newGenerationHighlightIds.add(id);
  };

  const consumeNewGenerationHighlightForPostId = (postId) => {
    const id = String(postId || "").trim();
    if (!id) return false;
    const changed = newGenerationHighlightIds.delete(id);
    if (changed) syncGridNewGenerationVisuals();
    return changed;
  };

  const consumeNewGenerationHighlight = (item) => {
    const ids = collectPostIdsForItem(item);
    if (!ids.size) return false;
    let changed = false;
    ids.forEach((id) => {
      if (newGenerationHighlightIds.delete(id)) changed = true;
    });
    if (!changed) return changed;
    syncGridNewGenerationVisuals();
    return changed;
  };

  const updateRegenDebugPanel = () => {
    if (!regenDebugEl) return;
    if (!REGEN_DEBUG_ENABLED) {
      regenDebugEl.classList.remove("show");
      regenDebugEl.setAttribute("hidden", "hidden");
      if (regenDebugBodyEl) regenDebugBodyEl.textContent = "";
      return;
    }
    const lightboxOpen = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    const activePostId = getActiveRegenPostId();
    const job = getRegenJob(activePostId);
    const lines = job && Array.isArray(job.logs) ? job.logs : [];
    const shouldShow = lightboxOpen && (Boolean(job && job.running) || lines.length > 0);
    if (!shouldShow) {
      regenDebugEl.classList.remove("show");
      regenDebugEl.setAttribute("hidden", "hidden");
      if (regenDebugBodyEl) regenDebugBodyEl.textContent = "";
      return;
    }
    if (regenDebugBodyEl) {
      regenDebugBodyEl.textContent = lines.join("\n");
      regenDebugBodyEl.scrollTop = regenDebugBodyEl.scrollHeight;
    }
    regenDebugEl.removeAttribute("hidden");
    regenDebugEl.classList.add("show");
  };

  const appendRegenLog = (postId, message) => {
    if (!REGEN_DEBUG_ENABLED) return;
    const job = getOrCreateRegenJob(postId);
    if (!job) return;
    const line = `[${formatTime(new Date())}] ${String(message || "")}`;
    job.logs.push(line);
    if (job.logs.length > REGEN_LOG_LIMIT) {
      job.logs.splice(0, job.logs.length - REGEN_LOG_LIMIT);
    }
    updateRegenDebugPanel();
  };

  const clearRegenLogs = (postId) => {
    if (!REGEN_DEBUG_ENABLED) return;
    const job = getOrCreateRegenJob(postId);
    if (!job) return;
    job.logs = [];
    updateRegenDebugPanel();
  };

  const clearRegenNoticeTimer = () => {
    if (!regenNoticeTimer) return;
    clearTimeout(regenNoticeTimer);
    regenNoticeTimer = null;
  };

  const hideRegenNotice = () => {
    clearRegenNoticeTimer();
    if (!regenNoticeEl) return;
    regenNoticeEl.classList.remove("show", "error");
    if (regenNoticeTextEl) {
      regenNoticeTextEl.textContent = "";
    } else {
      regenNoticeEl.textContent = "";
    }
  };

  const showRegenNotice = (message, type, timeoutMs) => {
    if (!regenNoticeEl || !message) return;
    clearRegenNoticeTimer();
    if (regenNoticeTextEl) {
      regenNoticeTextEl.textContent = message;
    } else {
      regenNoticeEl.textContent = message;
    }
    regenNoticeEl.classList.remove("error");
    if (type === "error") regenNoticeEl.classList.add("error");
    regenNoticeEl.classList.add("show");
    const delay = Number.isFinite(timeoutMs) ? timeoutMs : 4200;
    if (delay > 0) {
      regenNoticeTimer = setTimeout(() => {
        hideRegenNotice();
      }, Math.max(900, delay));
    }
  };

  const setRegenOverlayVisible = (visible) => {
    if (!regenOverlayEl) return;
    const show = !!visible;
    regenOverlayEl.classList.toggle("show", show);
    regenOverlayEl.setAttribute("aria-hidden", show ? "false" : "true");
    if (regenStopBtn) regenStopBtn.disabled = !show;
  };

  const syncRegenOverlay = () => {
    const lightboxOpen = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
    if (!lightboxOpen) {
      setRegenOverlayVisible(false);
      updateRegenDebugPanel();
      return;
    }
    const activePostId = getActiveRegenPostId();
    const job = getRegenJob(activePostId);
    if (!job || !job.running) {
      setRegenOverlayVisible(false);
      if (regenStopBtn) regenStopBtn.disabled = true;
      updateRegenDebugPanel();
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    if (regenProgressFillEl) regenProgressFillEl.style.setProperty("--regen-pct", String(pct));
    if (regenProgressTextEl) regenProgressTextEl.textContent = `${pct}%`;
    setRegenOverlayVisible(true);
    if (regenStopBtn) regenStopBtn.disabled = false;
    updateRegenDebugPanel();
  };

  const setRegenProgress = (postId, progressValue, textOverride) => {
    const job = getOrCreateRegenJob(postId);
    if (!job) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(progressValue) || 0)));
    job.progress = pct;
    if (textOverride && getActiveRegenPostId() === job.postId && regenProgressTextEl && /(\d{1,3})/.test(String(textOverride))) {
      const match = String(textOverride).match(/(\d{1,3})/);
      if (match) regenProgressTextEl.textContent = `${Math.max(0, Math.min(100, Number(match[1]) || 0))}%`;
    }
    syncRegenOverlay();
    syncThumbRegenIndicators(job.postId);
  };

  const clearRegenCooldownTimer = () => {
    if (!regenCooldownTimer) return;
    clearInterval(regenCooldownTimer);
    regenCooldownTimer = null;
  };

  const startRegenCooldown = () => {
    regenState.cooldownUntil = Date.now() + REGEN_COOLDOWN_MS;
    clearRegenCooldownTimer();
    regenCooldownTimer = setInterval(() => {
      if (Date.now() >= regenState.cooldownUntil) {
        regenState.cooldownUntil = 0;
        clearRegenCooldownTimer();
      }
      updateActionButtons();
    }, 250);
  };

  const getRegenCooldownSeconds = () => {
    const leftMs = regenState.cooldownUntil - Date.now();
    if (leftMs <= 0) return 0;
    return Math.ceil(leftMs / 1000);
  };

  const resolveRegenIconPath = () => (isGridMode() ? "images/thumbnail/regen.svg" : "images/regen.svg");

  const updateRegenButtonVisual = () => {
    if (!regenBtn) return;
    const icon = regenBtn.querySelector("img");
    if (icon) {
      const nextPath = chrome.runtime.getURL(resolveRegenIconPath());
      if (icon.src !== nextPath) icon.src = nextPath;
    }
  };

  const buildImageReferenceFallback = (postId) => {
    const id = String(postId || "").trim();
    if (!id) return "";
    return `https://imagine-public.x.ai/imagine-public/images/${id}.jpg`;
  };

  const getParentImageFallbackUrl = (item) => {
    if (!item) return "";
    const parentId = String(item.parentPostId || item.originalPostId || "").trim();
    if (!parentId) return "";
    return normalizeUrl(buildImageReferenceFallback(parentId));
  };

  const getBestPosterUrl = (item, options = {}) => {
    if (!item) return "";
    const preferSource = Boolean(options && options.preferSource);
    const sourceImage = normalizeUrl(String(item.sourceImageUrl || "").trim());
    const posterImage = normalizeUrl(String(item.poster || "").trim());
    const parentFallback = getParentImageFallbackUrl(item);
    const ownFallback = normalizeUrl(buildImageReferenceFallback(item.postId || ""));
    const ordered = preferSource
      ? [sourceImage, parentFallback, ownFallback, posterImage]
      : [posterImage, sourceImage, parentFallback, ownFallback];
    for (let i = 0; i < ordered.length; i += 1) {
      const candidate = ordered[i];
      if (!candidate || isMp4(candidate, item.mimeType)) continue;
      return optimizeThumbUrl(candidate);
    }
    return "";
  };

  const sanitizeRegenPrompt = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const normalizeRegenMode = (mode, prompt) => {
    const raw = String(mode || "").trim().toLowerCase();
    if (raw === "custom") return prompt ? "custom" : "normal";
    if (raw === "normal") return "normal";
    return prompt ? "custom" : "normal";
  };

  const normalizeVideoLength = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 6;
    return Math.max(2, Math.min(60, Math.round(parsed)));
  };

  const normalizeResolutionName = (value) => {
    const text = String(value || "").trim();
    return text || "480p";
  };

  const makeUuidLike = () => {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
    } catch (error) {}
    const part = (size) => {
      let out = "";
      const chars = "0123456789abcdef";
      for (let i = 0; i < size; i += 1) {
        out += chars[Math.floor(Math.random() * chars.length)];
      }
      return out;
    };
    return `${part(8)}-${part(4)}-${part(4)}-${part(4)}-${part(12)}`;
  };

  const encodeBase64 = (value) => {
    const text = String(value || "");
    try {
      return btoa(unescape(encodeURIComponent(text)));
    } catch (error) {
      try {
        return btoa(text);
      } catch (error2) {
        return "";
      }
    }
  };
  const looksLikeStatsigHeader = (value) => {
    const text = String(value || "").trim();
    if (!text) return false;
    if (text.length < 80 || text.length > 140) return false;
    return /^[A-Za-z0-9+/_=-]+$/.test(text);
  };
  const makeStatsigLikeId = () => {
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(70);
        window.crypto.getRandomValues(bytes);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        const generated = btoa(binary).replace(/=+$/g, "");
        if (looksLikeStatsigHeader(generated)) return generated;
      }
    } catch (error) {}
    const seed = `${Date.now()}-${Math.random()}-${location.href}-${makeUuidLike()}`;
    const fallback = encodeBase64(seed + seed).replace(/=+$/g, "");
    if (looksLikeStatsigHeader(fallback)) return fallback;
    return encodeBase64(`${seed}-${seed}-${seed}`).replace(/=+$/g, "").slice(0, 96);
  };

  const resolveStatsigHeader = () => {
    const fromStorage = (storageObj) => {
      if (!storageObj) return "";
      const directKeys = [
        "statsig.stable_id",
        "statsigStableId",
        "statsig_stable_id",
        "x-statsig-id",
        "x_statsig_id"
      ];
      for (let i = 0; i < directKeys.length; i += 1) {
        try {
          const value = String(storageObj.getItem(directKeys[i]) || "").trim();
          if (looksLikeStatsigHeader(value)) return value;
        } catch (error) {}
      }
      let keys = [];
      try {
        keys = Object.keys(storageObj);
      } catch (error) {
        keys = [];
      }
      for (let i = 0; i < keys.length; i += 1) {
        const key = String(keys[i] || "").toLowerCase();
        if (!key.includes("statsig")) continue;
        let raw = "";
        try {
          raw = String(storageObj.getItem(keys[i]) || "");
        } catch (error) {
          raw = "";
        }
        if (!raw) continue;
        const trimmed = raw.trim();
        if (looksLikeStatsigHeader(trimmed)) return trimmed;
        try {
          const parsed = JSON.parse(raw);
          const nestedCandidates = [
            parsed,
            parsed && parsed.stableID,
            parsed && parsed.stableId,
            parsed && parsed.statsigStableId,
            parsed && parsed.statsig_stable_id,
            parsed && parsed.statsigId,
            parsed && parsed.id,
            parsed && parsed.value
          ];
          for (let j = 0; j < nestedCandidates.length; j += 1) {
            const candidate = String(nestedCandidates[j] || "").trim();
            if (looksLikeStatsigHeader(candidate)) return candidate;
          }
        } catch (error) {}
      }
      return "";
    };
    let value = "";
    try {
      value = fromStorage(window.localStorage);
    } catch (error) {}
    if (value) return value;
    try {
      value = fromStorage(window.sessionStorage);
    } catch (error) {}
    if (value) return value;
    return makeStatsigLikeId();
  };

  const buildRegenRequestHeaders = () => ({
    "content-type": "application/json",
    accept: "*/*",
    "x-xai-request-id": makeUuidLike(),
    "x-statsig-id": resolveStatsigHeader()
  });

  const fetchPostDetails = async (postId) => {
    if (!postId) return null;
    const response = await fetch(POST_GET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: postId })
    });
    if (!response.ok) throw new Error(`post/get HTTP ${response.status}`);
    const data = await response.json();
    return data && data.post ? data.post : null;
  };

  const deriveHdMetaFromDetail = (detailPost, targetPostId) => {
    if (!detailPost || typeof detailPost !== "object") {
      return {
        resolutionName: "",
        resolutionWidth: 0,
        resolutionHeight: 0,
        hasSignal: false,
        isHD: false
      };
    }
    const targetId = String(targetPostId || "").trim();
    const candidates = [
      detailPost,
      ...(Array.isArray(detailPost.videos) ? detailPost.videos : []),
      ...(Array.isArray(detailPost.childPosts) ? detailPost.childPosts : [])
    ].filter(Boolean);
    let matched = null;
    if (targetId) {
      matched = candidates.find((entry) => String((entry && entry.id) || "").trim() === targetId) || null;
    }
    if (!matched) matched = detailPost;
    const baseVideo =
      detailPost && Array.isArray(detailPost.videos) && detailPost.videos.length ? detailPost.videos[0] : null;
    const matchedResolution = extractResolutionPair(matched);
    const detailResolution = extractResolutionPair(detailPost);
    const baseResolution = extractResolutionPair(baseVideo);
    const resolutionName = String(
      (matched && matched.resolutionName) || (detailPost && detailPost.resolutionName) || (baseVideo && baseVideo.resolutionName) || ""
    ).trim();
    const resolutionWidth = toPositiveSize(
      matchedResolution.width || detailResolution.width || baseResolution.width || 0
    );
    const resolutionHeight = toPositiveSize(
      matchedResolution.height || detailResolution.height || baseResolution.height || 0
    );
    const hasSignal =
      parseResolutionHeightFromName(resolutionName) !== null || Boolean(resolutionWidth || resolutionHeight);
    return {
      resolutionName,
      resolutionWidth,
      resolutionHeight,
      hasSignal,
      isHD: hasSignal ? isHdResolutionMeta(resolutionName, resolutionWidth, resolutionHeight) : false
    };
  };

  const patchHdMetaIntoVideoCache = (postId, meta) => {
    const key = String(postId || "").trim();
    if (!key || !meta) return;
    const modeState = getModeState("videos");
    modeState.pageCache.forEach((pageItems, pageKey) => {
      let changed = false;
      const patched = (pageItems || []).map((entry) => {
        if (!entry || String(entry.postId || "").trim() !== key) return entry;
        changed = true;
        return {
          ...entry,
          resolutionName: meta.resolutionName || entry.resolutionName || "",
          resolutionWidth: meta.resolutionWidth || entry.resolutionWidth || 0,
          resolutionHeight: meta.resolutionHeight || entry.resolutionHeight || 0,
          isHD: meta.hasSignal ? meta.isHD === true : entry.isHD
        };
      });
      if (changed) modeState.pageCache.set(pageKey, patched);
    });
  };

  const shouldProbeHdMeta = (item) => {
    if (!item) return false;
    const postId = String(item.postId || "").trim();
    if (!postId) return false;
    if (hdMetaByPostId.has(postId)) return false;
    if (hdProbeInFlight.has(postId) || hdProbeQueued.has(postId)) return false;
    if (item.isHD === true) return false;
    if (!hasHdResolutionSignal(item)) return true;
    const namedHeight = parseResolutionHeightFromName(item.resolutionName);
    if (namedHeight !== null && namedHeight >= 720) return false;
    if (hasHdUrlCandidate(item)) return true;
    return false;
  };

  const syncVisibleHdBadges = () => {
    if (!gridEl || state.mode !== "videos") return;
    const thumbs = gridEl.querySelectorAll(".thumb[data-index]");
    for (let i = 0; i < thumbs.length; i += 1) {
      const thumb = thumbs[i];
      const idx = Number(thumb.dataset.index || "-1");
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.items.length) continue;
      const item = state.items[idx];
      const displayItem = resolveActiveItem(item) || item;
      const show = isHdVideoItem(displayItem);
      const existing = thumb.querySelector(".thumb-hd-tag");
      if (show) {
        if (!existing) {
          const hdTag = document.createElement("span");
          hdTag.className = "thumb-hd-tag";
          hdTag.textContent = "HD";
          thumb.appendChild(hdTag);
        }
      } else if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }
  };

  const pumpHdProbeQueue = () => {
    while (hdProbeRunning < HD_PROBE_MAX && hdProbeQueue.length) {
      const postId = hdProbeQueue.shift();
      const key = String(postId || "").trim();
      hdProbeQueued.delete(key);
      if (!key || hdProbeInFlight.has(key) || hdMetaByPostId.has(key)) continue;
      hdProbeInFlight.add(key);
      hdProbeRunning += 1;
      fetchPostDetails(key)
        .then((detail) => {
          const meta = deriveHdMetaFromDetail(detail, key);
          hdMetaByPostId.set(key, meta);
          patchHdMetaIntoVideoCache(key, meta);
          syncVisibleHdBadges();
        })
        .catch(() => {
          hdMetaByPostId.set(key, {
            resolutionName: "",
            resolutionWidth: 0,
            resolutionHeight: 0,
            hasSignal: false,
            isHD: false
          });
        })
        .finally(() => {
          hdProbeInFlight.delete(key);
          hdProbeRunning = Math.max(0, hdProbeRunning - 1);
          pumpHdProbeQueue();
        });
    }
  };

  const queueHdProbe = (item) => {
    if (!shouldProbeHdMeta(item)) return;
    const postId = String(item.postId || "").trim();
    hdProbeQueued.add(postId);
    hdProbeQueue.push(postId);
    pumpHdProbeQueue();
  };

  const buildRegenMessage = (imageReference, prompt, requestedMode) => {
    const safePrompt = sanitizeRegenPrompt(prompt || "");
    let mode = normalizeRegenMode(requestedMode, safePrompt);
    if (mode === "custom" && !safePrompt) mode = "normal";
    const parts = [];
    if (imageReference) parts.push(String(imageReference).trim());
    if (mode === "custom" && safePrompt) parts.push(safePrompt);
    if (!parts.length && safePrompt) parts.push(safePrompt);
    parts.push(`--mode=${mode}`);
    return parts.join("  ").trim();
  };

  const buildRegenContext = (item, detail) => {
    const active = resolveActiveItem(item) || item;
    const detailPost = detail || null;
    const detailPrompt = getPostPromptText(detailPost);
    const itemPrompt = sanitizeRegenPrompt(getPromptTextForItem(item) || "");
    const prompt = sanitizeRegenPrompt(detailPrompt || itemPrompt || "");

    const detailMediaType = String((detailPost && detailPost.mediaType) || "").toUpperCase();
    const fromDetailParent =
      (detailPost &&
        (detailPost.originalPostId ||
          detailPost.parentPostId ||
          (detailPost.originalPost && detailPost.originalPost.id) ||
          (detailMediaType.includes("IMAGE") ? detailPost.id : ""))) ||
      "";
    let parentPostId =
      String(
        fromDetailParent ||
          (active && (active.parentPostId || active.originalPostId || active.postId)) ||
          ""
      ).trim();

    const imageCandidates = [
      detailPost && detailPost.originalPost && detailPost.originalPost.mediaUrl,
      detailPost && Array.isArray(detailPost.images) && detailPost.images[0] && detailPost.images[0].mediaUrl,
      detailMediaType.includes("IMAGE") && detailPost ? detailPost.mediaUrl : "",
      active && active.sourceImageUrl,
      active && active.url && isImage(active.url, active.mimeType) ? active.url : "",
      buildImageReferenceFallback(parentPostId)
    ];
    let imageReference = "";
    for (let i = 0; i < imageCandidates.length; i += 1) {
      const candidate = normalizeUrl(imageCandidates[i] || "");
      if (!candidate) continue;
      if (isImage(candidate, "")) {
        imageReference = candidate;
        break;
      }
    }
    if (!imageReference && parentPostId) {
      imageReference = buildImageReferenceFallback(parentPostId);
    }
    if (!parentPostId && imageReference) {
      parentPostId = extractImageId(imageReference) || parentPostId;
    }
    if (!parentPostId && detailPost && detailPost.id) parentPostId = String(detailPost.id);

    const aspectRatioFromDetail =
      normalizeAspectRatioText(detailPost && detailPost.aspectRatio) ||
      normalizeAspectRatioText(detailPost && detailPost.mediaAspectRatio) ||
      normalizeAspectRatioText(detailPost && detailPost.ratio);
    const detailRes = extractResolutionPair(detailPost);
    const originalRes = extractResolutionPair(detailPost && detailPost.originalPost ? detailPost.originalPost : null);
    const activeWidth = toPositiveSize(active && active.mediaWidth);
    const activeHeight = toPositiveSize(active && active.mediaHeight);
    const width = detailRes.width || originalRes.width || activeWidth;
    const height = detailRes.height || originalRes.height || activeHeight;
    const aspectRatio = aspectRatioFromDetail || pickAspectRatioFromDimensions(width, height);

    const baseVideo = detailPost && Array.isArray(detailPost.videos) && detailPost.videos.length ? detailPost.videos[0] : null;
    const resolutionName = normalizeResolutionName(
      (detailPost && detailPost.resolutionName) || (baseVideo && baseVideo.resolutionName) || "480p"
    );
    const videoLength = normalizeVideoLength(
      (detailPost && detailPost.videoDuration) || (baseVideo && baseVideo.videoDuration) || 6
    );
    const mode = normalizeRegenMode((detailPost && detailPost.mode) || "", prompt);
    const message = buildRegenMessage(imageReference, prompt, mode);

    if ((!imageReference && !prompt) || !message || (!parentPostId && !imageReference)) return null;
    if (!parentPostId && imageReference) {
      parentPostId = extractImageId(imageReference) || parentPostId;
    }

    return {
      parentPostId: String(parentPostId || "").trim(),
      imageReference: imageReference || "",
      prompt,
      mode,
      aspectRatio,
      videoLength,
      resolutionName,
      message
    };
  };

  const buildRegenPayload = (context) => ({
    temporary: true,
    modelName: "grok-3",
    message: context.message,
    toolOverrides: { videoGen: true },
    enableSideBySide: true,
    responseMetadata: {
      experiments: [],
      modelConfigOverride: {
        modelMap: {
          videoGenModelConfig: {
            parentPostId: context.parentPostId,
            aspectRatio: context.aspectRatio,
            videoLength: context.videoLength,
            isVideoEdit: false,
            resolutionName: context.resolutionName
          }
        }
      }
    }
  });

  const toEpochMs = (value) => {
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const collectVideoItemsFromDetail = (detailPost) => {
    if (!detailPost || typeof detailPost !== "object") return [];
    try {
      const extracted = extractItems([detailPost]);
      return dedupeItems((extracted && extracted.videos) || []);
    } catch (error) {
      return [];
    }
  };

  const resolveRefreshedVideoItem = (
    detailPost,
    targetPostId,
    fallbackParentPostId,
    fallbackSourceImageUrl,
    fallbackPromptText
  ) => {
    if (!detailPost || typeof detailPost !== "object") return null;
    const targetId = String(targetPostId || "").trim();
    const direct = buildItem(
      detailPost,
      fallbackParentPostId || "",
      fallbackSourceImageUrl || "",
      fallbackPromptText || ""
    );
    if (direct && (!targetId || String(direct.postId || "").trim() === targetId)) {
      return direct;
    }
    const videos = collectVideoItemsFromDetail(detailPost);
    if (!videos.length) return direct || null;
    if (targetId) {
      for (let i = 0; i < videos.length; i += 1) {
        const candidate = videos[i];
        if (String((candidate && candidate.postId) || "").trim() === targetId) {
          return candidate;
        }
      }
    }
    return videos[0] || direct || null;
  };

  const pickRegenWatcherCandidate = ({
    videos,
    baselineIds,
    sourcePostId,
    parentPostId,
    imageReference,
    startedAtMs
  }) => {
    const sourceId = String(sourcePostId || "").trim();
    const parentId = String(parentPostId || "").trim();
    const imageId = extractImageId(imageReference || "");
    const baseline = baselineIds instanceof Set ? baselineIds : new Set();
    const minCreatedAt = Number(startedAtMs || 0) - 120000;
    let best = null;
    let bestScore = -1;
    let bestTime = -1;

    (videos || []).forEach((item) => {
      if (!item) return;
      const postId = String(item.postId || "").trim();
      if (!postId || postId === sourceId || baseline.has(postId)) return;

      const createdMs = toEpochMs(item.createdAt);
      if (createdMs && createdMs < minCreatedAt) return;

      const candidateParent = String(item.parentPostId || "").trim();
      const candidateOriginal = String(item.originalPostId || "").trim();
      const sourceImageUrl = String(item.sourceImageUrl || "").trim();
      const sourceImageId = extractImageId(sourceImageUrl);
      let score = 0;

      if (sourceId && candidateParent === sourceId) score += 6;
      if (sourceId && candidateOriginal === sourceId) score += 8;
      if (parentId && candidateParent === parentId) score += 5;
      if (parentId && candidateOriginal === parentId) score += 4;
      if (parentId && sourceImageId === parentId) score += 3;
      if (imageId && sourceImageId === imageId) score += 2;
      if (sourceId && String(item.url || "").includes(sourceId)) score += 2;
      if (parentId && String(item.url || "").includes(parentId)) score += 1;
      if (!score) {
        // Fallback conservativo: un post nuovo, non baseline, apparso dopo l'inizio regen.
        if (!createdMs || createdMs < Number(startedAtMs || 0) - 1000) return;
        score = 1;
      }

      const timeScore = createdMs || 0;
      if (score > bestScore || (score === bestScore && timeScore > bestTime)) {
        best = item;
        bestScore = score;
        bestTime = timeScore;
      }
    });

    return best || null;
  };

  const startNativeRegenApiWatcher = ({
    sourcePostId,
    parentPostId,
    imageReference,
    startedAtMs,
    seedIds,
    getRequestId,
    signal,
    onLog
  }) => {
    let stopped = false;
    let forced = false;
    const baselineIds = new Set();
    (seedIds || []).forEach((id) => {
      const key = String(id || "").trim();
      if (key) baselineIds.add(key);
    });

    const sourceId = String(sourcePostId || "").trim();
    const parentId = String(parentPostId || "").trim();
    const postIds = [];
    if (sourceId) postIds.push(sourceId);
    if (parentId && parentId !== sourceId) postIds.push(parentId);

    const log = (line) => {
      if (typeof onLog === "function" && line) onLog(String(line));
    };

    const loadDetailVideos = async () => {
      const out = [];
      for (let i = 0; i < postIds.length; i += 1) {
        const postId = postIds[i];
        if (!postId) continue;
        let detail = null;
        try {
          detail = await fetchPostDetails(postId);
        } catch (error) {
          detail = null;
        }
        const videos = collectVideoItemsFromDetail(detail);
        for (let j = 0; j < videos.length; j += 1) out.push(videos[j]);
      }
      return dedupeItems(out);
    };

    const loop = async () => {
      const seededVideos = await loadDetailVideos();
      seededVideos.forEach((item) => {
        const postId = String((item && item.postId) || "").trim();
        if (postId) baselineIds.add(postId);
      });

      while (!stopped && !forced && !(signal && signal.aborted)) {
        await sleep(2200);
        if (stopped || forced || (signal && signal.aborted)) break;

        const videos = await loadDetailVideos();
        const candidate = pickRegenWatcherCandidate({
          videos,
          baselineIds,
          sourcePostId: sourceId,
          parentPostId: parentId,
          imageReference,
          startedAtMs
        });
        if (!candidate) continue;

        const requestId = String((typeof getRequestId === "function" && getRequestId()) || "").trim();
        if (!requestId) continue;

        forced = true;
        log(`API watcher detected completion candidate ${String(candidate.postId || "n/a")}`);
        const payload = {
          action: "grokViewerRegenForceCompleteNativeTab",
          requestId,
          videoPostId: String(candidate.postId || ""),
          videoUrl: normalizeUrl(String(candidate.playbackUrl || candidate.url || "")),
          thumbnailImageUrl: normalizeUrl(String(candidate.poster || candidate.sourceImageUrl || "")),
          parentPostId: String(candidate.parentPostId || parentId || "")
        };
        await new Promise((resolve) => {
          chrome.runtime.sendMessage(payload, () => resolve());
        });
        break;
      }
    };

    loop();
    return () => {
      stopped = true;
    };
  };

  const handleRegenStreamObject = (data, tracker, hooks) => {
    const onLog = hooks && typeof hooks.onLog === "function" ? hooks.onLog : null;
    const onProgress = hooks && typeof hooks.onProgress === "function" ? hooks.onProgress : null;
    const responseNode = data && data.result && data.result.response ? data.result.response : null;
    if (!responseNode) return;
    const stream = responseNode.streamingVideoGenerationResponse;
    if (stream) {
      const progress = Number(stream.progress);
      if (Number.isFinite(progress)) {
        const pct = Math.max(0, Math.min(100, Math.round(progress)));
        if (pct !== tracker.progress) {
          tracker.progress = pct;
          if (onProgress) onProgress(pct);
        }
      }
      if (stream.videoPostId) tracker.videoPostId = String(stream.videoPostId);
      if (stream.videoUrl) tracker.videoUrl = normalizeUrl(stream.videoUrl);
      if (stream.thumbnailImageUrl) tracker.thumbnailImageUrl = normalizeUrl(stream.thumbnailImageUrl);
      if (stream.parentPostId) tracker.parentPostId = String(stream.parentPostId);
      if (stream.moderated === true) tracker.moderated = true;
      return;
    }
    const queryAction = responseNode.queryAction;
    if (queryAction && queryAction.type && !tracker.queryLogged) {
      tracker.queryLogged = true;
      if (onLog) onLog(`Query action: ${queryAction.type}`);
    }
  };

  const consumeRegenStream = async (response, tracker, hooks) => {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i += 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          handleRegenStreamObject(parsed, tracker, hooks);
        } catch (error) {}
      }
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            handleRegenStreamObject(parsed, tracker, hooks);
          } catch (error) {}
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      try {
        const parsed = JSON.parse(tail);
        handleRegenStreamObject(parsed, tracker, hooks);
      } catch (error) {}
    }
  };

  const consumeRegenViaMainWorld = (payload, tracker, signal, sourcePostId, hooks) =>
    new Promise((resolve, reject) => {
      const requestId = `gv-regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      const onLog = REGEN_DEBUG_ENABLED && hooks && typeof hooks.onLog === "function" ? hooks.onLog : null;
      const onProgress = hooks && typeof hooks.onProgress === "function" ? hooks.onProgress : null;
      const emitLog = (message) => {
        if (!onLog || !message) return;
        onLog(String(message));
      };

      const applyMainEventData = (data) => {
        if (!data || typeof data !== "object") return;
        const progress = Number(data.progress);
        if (Number.isFinite(progress)) {
          const pct = Math.max(0, Math.min(100, Math.round(progress)));
          if (pct !== tracker.progress) {
            tracker.progress = pct;
            if (onProgress) onProgress(pct);
          }
        }
        if (data.videoPostId) tracker.videoPostId = String(data.videoPostId);
        if (data.videoUrl) tracker.videoUrl = normalizeUrl(String(data.videoUrl));
        if (data.thumbnailImageUrl) tracker.thumbnailImageUrl = normalizeUrl(String(data.thumbnailImageUrl));
        if (data.parentPostId) tracker.parentPostId = String(data.parentPostId);
        if (data.moderated === true) tracker.moderated = true;
      };

      const onMessage = (event) => {
        if (!event || event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "grok-viewer" || data.requestId !== requestId) return;
        if (data.type === "regen-http") {
          const statusCode = Number(data.status || 0);
          if (statusCode > 0) {
            tracker.status = statusCode;
            const channel = data.channel ? ` (${String(data.channel)})` : "";
            const hasStatsig = data.hasStatsig === true ? " statsig:yes" : data.hasStatsig === false ? " statsig:no" : "";
            const statsigSource = data.statsigSource ? ` src:${String(data.statsigSource)}` : "";
            const statsigLength = Number(data.statsigLength || 0);
            const statsigLenText = statsigLength > 0 ? ` len:${statsigLength}` : "";
            const challenge = data.challengeDetected === true ? " cf:challenge" : "";
            const hint = data.errorHint ? ` hint:${String(data.errorHint)}` : "";
            const rid = data.xaiRequestId ? ` req:${String(data.xaiRequestId).slice(0, 8)}` : "";
            emitLog(`conversations/new HTTP ${statusCode}${channel}${hasStatsig}${statsigSource}${statsigLenText}${challenge}${hint}${rid}`);
          }
          return;
        }
        if (data.type === "regen-query") {
          const queryType = String(data.queryType || "");
          if (queryType && !tracker.queryLogged) {
            tracker.queryLogged = true;
            emitLog(`Query action: ${queryType}`);
          }
          return;
        }
        if (data.type === "regen-stream") {
          applyMainEventData(data);
        }
      };

      const onAbort = () => {
        chrome.runtime.sendMessage({ action: "grokViewerRegenAbortViaMain", requestId }, () => {});
      };

      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      window.addEventListener("message", onMessage);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      chrome.runtime.sendMessage({ action: "grokViewerRegenViaMain", requestId, payload, sourcePostId }, (response) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const result = response || { ok: false, status: 0, error: "no-main-response" };
        applyMainEventData(result);
        const statusCode = Number(result.status || 0);
        if (statusCode > 0 && !tracker.status) {
          tracker.status = statusCode;
          const channel = result.channel ? ` (${String(result.channel)})` : "";
          const hasStatsig = result.hasStatsig === true ? " statsig:yes" : result.hasStatsig === false ? " statsig:no" : "";
          const statsigSource = result.statsigSource ? ` src:${String(result.statsigSource)}` : "";
          const statsigLength = Number(result.statsigLength || 0);
          const statsigLenText = statsigLength > 0 ? ` len:${statsigLength}` : "";
          const challenge = result.challengeDetected === true ? " cf:challenge" : "";
          const hint = result.errorHint ? ` hint:${String(result.errorHint)}` : "";
          const rid = result.xaiRequestId ? ` req:${String(result.xaiRequestId).slice(0, 8)}` : "";
          emitLog(`conversations/new HTTP ${statusCode}${channel}${hasStatsig}${statsigSource}${statsigLenText}${challenge}${hint}${rid}`);
        }
        if (result.ok) {
          resolve(result);
          return;
        }
        const error = new Error(result.error || `regen-main-http-${statusCode || 0}`);
        if (statusCode) error.status = statusCode;
        if (result.aborted) error.name = "AbortError";
        reject(error);
      });
    });

  const consumeRegenViaNativeTab = (postId, tracker, signal, hooks) =>
    new Promise((resolve, reject) => {
      const requestId = `gv-regen-native-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      let timeoutId = null;
      let lastProgressSource = "";
      const onLog = REGEN_DEBUG_ENABLED && hooks && typeof hooks.onLog === "function" ? hooks.onLog : null;
      const onProgress = hooks && typeof hooks.onProgress === "function" ? hooks.onProgress : null;
      const onRequestId = hooks && typeof hooks.onRequestId === "function" ? hooks.onRequestId : null;
      if (onRequestId) {
        try {
          onRequestId(requestId);
        } catch (error) {}
      }

      const emitLog = (message) => {
        if (!onLog || !message) return;
        onLog(String(message));
      };

      const applyNativeEventData = (data) => {
        if (!data || typeof data !== "object") return;
        const progress = Number(data.progress);
        if (Number.isFinite(progress)) {
          const pct = Math.max(0, Math.min(100, Math.round(progress)));
          if (pct !== tracker.progress) {
            tracker.progress = pct;
            if (onProgress) onProgress(pct);
          }
        }
        if (data.videoPostId) tracker.videoPostId = String(data.videoPostId);
        if (data.videoUrl) tracker.videoUrl = normalizeUrl(String(data.videoUrl));
        if (data.thumbnailImageUrl) tracker.thumbnailImageUrl = normalizeUrl(String(data.thumbnailImageUrl));
        if (data.parentPostId) tracker.parentPostId = String(data.parentPostId);
        if (data.moderated === true) tracker.moderated = true;
      };

      const cleanup = () => {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const finishResolve = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload || {});
      };

      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error || "native-regen-failed")));
      };

      const onRuntimeMessage = (message) => {
        if (!message || message.action !== "grokViewerRegenNativeEvent" || message.requestId !== requestId) return;
        const eventType = String(message.type || "").trim();
        if (!eventType) return;

        if (eventType === "opened") {
          const tabId = Number(message.targetTabId || 0);
          if (tabId) emitLog(`Native tab opened id=${tabId}`);
          return;
        }

        if (eventType === "clicked") {
          const confirmLabel = message.confirmLabel ? String(message.confirmLabel) : "";
          if (message.confirmed === true) {
            emitLog(`Repeat clicked and confirmed (${confirmLabel || "create video"})`);
          } else {
            emitLog("Repeat clicked on native post page");
          }
          return;
        }

        if (eventType === "http") {
          const statusCode = Number(message.status || 0);
          if (statusCode > 0) tracker.status = statusCode;
          const challenge = message.challengeDetected === true ? " cf:challenge" : "";
          const hint = message.errorHint ? ` hint:${String(message.errorHint)}` : "";
          emitLog(`conversations/new HTTP ${statusCode || 0} (native-post-tab)${challenge}${hint}`);
          return;
        }

        if (eventType === "query") {
          const queryType = String(message.queryType || "");
          if (queryType && !tracker.queryLogged) {
            tracker.queryLogged = true;
            emitLog(`Query action: ${queryType}`);
          }
          return;
        }

        if (eventType === "diag") {
          if (!onLog) return;
          const source = message.progressSource ? String(message.progressSource) : "-";
          const prev = Number.isFinite(Number(message.prevProgress)) ? Math.round(Number(message.prevProgress)) : 0;
          const raw = Number.isFinite(Number(message.rawProgress)) ? Math.round(Number(message.rawProgress)) : 0;
          const eff = Number.isFinite(Number(message.effectiveProgress)) ? Math.round(Number(message.effectiveProgress)) : 0;
          const tick100 = Number(message.hundredTicks || 0);
          const tick95 = Number(message.highTicks || 0);
          const status = Number(message.status || 0);
          const seen = message.requestSeen === true ? "yes" : "no";
          const streams = Number(message.streamCount || 0);
          const seq = Number(message.seq || 0);
          const nudge = message.nudgeSent === true ? "yes" : "no";
          const nudgeCount = Number(message.nudgeCount || 0);
          const probe = Number.isFinite(Number(message.probeProgress)) && Number(message.probeProgress) >= 0
            ? `${Math.round(Number(message.probeProgress))}%`
            : "-";
          const dom = Number.isFinite(Number(message.domProgress)) && Number(message.domProgress) >= 0
            ? `${Math.round(Number(message.domProgress))}%`
            : "-";
          const hint = message.generationHintVisible === true ? "yes" : "no";
          const ready = message.readyActionVisible === true ? "yes" : "no";
          const isNew = message.isNewVideo === true ? "yes" : "no";
          emitLog(
            `diag src:${source} prev:${prev}% raw:${raw}% eff:${eff}% probe:${probe} dom:${dom} status:${status} reqSeen:${seen} streams:${streams} seq:${seq} nudge:${nudge}#${nudgeCount} 100t:${tick100} 95t:${tick95} hint:${hint} ready:${ready} new:${isNew}`
          );
          return;
        }

        if (eventType === "stream") {
          const source = String(message.progressSource || "").trim().toLowerCase();
          if (source && source !== lastProgressSource) {
            lastProgressSource = source;
            emitLog(`Progress source: ${source}`);
          }
          applyNativeEventData(message);
          return;
        }

        if (eventType === "completed") {
          applyNativeEventData(message);
          if (onProgress) onProgress(100);
          finishResolve(message);
          return;
        }

        if (eventType === "aborted") {
          const abortError = new Error("native-regen-aborted");
          abortError.name = "AbortError";
          finishReject(abortError);
          return;
        }

        if (eventType === "failed") {
          const statusCode = Number(message.status || 0);
          const error = new Error(String(message.error || "native-regen-failed"));
          if (statusCode) error.status = statusCode;
          if (message.challengeDetected === true) error.challengeDetected = true;
          if (message.errorHint) error.errorHint = String(message.errorHint);
          if (message.moderated === true) error.moderated = true;
          finishReject(error);
        }
      };

      const onAbort = () => {
        chrome.runtime.sendMessage({ action: "grokViewerRegenAbortNativeTab", requestId }, () => {});
      };

      chrome.runtime.onMessage.addListener(onRuntimeMessage);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timeoutId = setTimeout(() => {
        const timeoutError = new Error("native-regen-timeout");
        finishReject(timeoutError);
      }, 4 * 60 * 1000);

      chrome.runtime.sendMessage({ action: "grokViewerRegenViaNativeTab", requestId, postId }, (response) => {
        if (settled) return;
        if (chrome.runtime.lastError) {
          finishReject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const result = response || { ok: false, error: "no-native-response" };
        if (!result.ok) {
          const statusCode = Number(result.status || 0);
          const error = new Error(String(result.error || "native-regen-start-failed"));
          if (statusCode) error.status = statusCode;
          finishReject(error);
          return;
        }
        if (result.targetTabId) {
          emitLog(`Native post tab ready id=${Number(result.targetTabId)}`);
        }
      });
    });

  const stopRegeneration = (reason, postId) => {
    const targetPostId = String(postId || getActiveRegenPostId() || "").trim();
    if (!targetPostId) return;
    const job = getRegenJob(targetPostId);
    if (!job || !job.running || !job.abortController) return;
    appendRegenLog(targetPostId, reason || "Stop requested");
    job.abortController.abort();
  };

  const startRegeneration = async () => {
    const selected = state.items[state.selectedIndex];
    const active = resolveActiveItem(selected);
    if (!selected || !active) return;
    const jobPostId = active.postId ? String(active.postId).trim() : "";
    if (!jobPostId) {
      showRegenNotice("Regeneration unavailable for this item.", "error");
      return;
    }
    const runningCount = getRunningRegenCount();
    const existingJob = getRegenJob(jobPostId);
    if (existingJob && existingJob.running) {
      regenState.activePostId = jobPostId;
      syncRegenOverlay();
      showRegenNotice("Regeneration already running for this item.", "error");
      return;
    }
    if (runningCount >= REGEN_MAX_CONCURRENT) {
      showRegenNotice(`Maximum ${REGEN_MAX_CONCURRENT} regenerations at once.`, "error");
      return;
    }
    const cooldownSeconds = getRegenCooldownSeconds();
    if (cooldownSeconds > 0 && runningCount === 0) {
      showRegenNotice(`Please wait ${cooldownSeconds}s before regenerating again.`, "error");
      return;
    }
    const job = getOrCreateRegenJob(jobPostId);
    if (!job) return;
    clearRegenLogs(jobPostId);
    hideRegenNotice();
    job.running = true;
    job.progress = 0;
    job.abortController = new AbortController();
    regenState.activePostId = jobPostId;
    regenState.lastJobAt = Date.now();
    setRegenProgress(jobPostId, 1, "Regeneration 1%");
    syncRegenOverlay();
    updateActionButtons();
    appendRegenLog(jobPostId, `Starting regeneration for post ${active.postId}`);
    let lastLoggedProgress = -1;
    let stopApiWatcher = () => {};

    try {
      let detail = null;
      try {
        detail = await fetchPostDetails(active.postId);
        appendRegenLog(jobPostId, "post/get completed");
      } catch (error) {
        appendRegenLog(jobPostId, `post/get failed: ${error.message || error}`);
      }

      const context = buildRegenContext(selected, detail);
      if (!context) {
        throw new Error("regen-context-unavailable");
      }
      if (!context.parentPostId) {
        throw new Error("regen-parent-missing");
      }

      const payload = buildRegenPayload(context);
      appendRegenLog(jobPostId, `Payload ready mode=${context.mode} ratio=${context.aspectRatio} len=${context.videoLength}s`);
      const messagePreview = context.message.length > 180 ? `${context.message.slice(0, 180)}...` : context.message;
      appendRegenLog(jobPostId, `Message: ${messagePreview}`);
      startRegenCooldown();
      const tracker = {
        progress: 1,
        moderated: false,
        videoPostId: "",
        videoUrl: "",
        thumbnailImageUrl: "",
        parentPostId: context.parentPostId,
        queryLogged: false,
        status: 0
      };
      const nativePostId = String(active.postId || selected.postId || context.parentPostId || "").trim();
      if (!nativePostId) {
        throw new Error("regen-post-id-missing");
      }
      appendRegenLog(jobPostId, "Channel: native post tab bridge");
      let nativeRequestId = "";
      const seedIds = new Set();
      seedIds.add(jobPostId);
      seedIds.add(nativePostId);
      if (selected && Array.isArray(selected.variants)) {
        selected.variants.forEach((variant) => {
          const id = String((variant && variant.postId) || "").trim();
          if (id) seedIds.add(id);
        });
      }
      stopApiWatcher = startNativeRegenApiWatcher({
        sourcePostId: nativePostId,
        parentPostId: context.parentPostId,
        imageReference: context.imageReference,
        startedAtMs: Date.now(),
        seedIds: Array.from(seedIds),
        getRequestId: () => nativeRequestId,
        signal: job.abortController.signal,
        onLog: (line) => appendRegenLog(jobPostId, line)
      });
      await consumeRegenViaNativeTab(nativePostId, tracker, job.abortController.signal, {
        onRequestId: (id) => {
          nativeRequestId = String(id || "").trim();
        },
        onLog: (line) => appendRegenLog(jobPostId, line),
        onProgress: (pct) => {
          setRegenProgress(jobPostId, pct);
          if (pct !== lastLoggedProgress) {
            lastLoggedProgress = pct;
            appendRegenLog(jobPostId, `Progress ${pct}%`);
          }
        }
      });

      if (tracker.moderated) {
        appendRegenLog(jobPostId, "Moderated=true detected");
        showRegenNotice("Generation failed, likely due to NSFW moderation.", "error", 5200);
        return;
      }
      if (!tracker.videoUrl && !tracker.videoPostId) {
        appendRegenLog(jobPostId, "No final video payload received");
        showRegenNotice("Generation did not complete. No final payload received.", "error", 5200);
        return;
      }

      setRegenProgress(jobPostId, 100, "Regeneration 100%");
      const generatedPostId = String(tracker.videoPostId || extractMp4Id(tracker.videoUrl || "") || "").trim();
      if (generatedPostId) markNewGenerationHighlight(generatedPostId);
      appendRegenLog(jobPostId, `Completed videoPostId=${tracker.videoPostId || "n/a"}`);
      await refresh({ silent: true, includeOtherMode: true });
      const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
      if (lightboxOpenNow) {
        loadPlayer();
        showRegenNotice("New generation completed, check it in the Viewer! 🙋🏼", "", 0);
      } else {
        showRegenCreatedNotice();
      }
      appendRegenLog(jobPostId, "Silent refresh completed");
    } catch (error) {
      const aborted =
        error && (error.name === "AbortError" || String(error.message || "").toLowerCase().includes("abort"));
      if (aborted) {
        appendRegenLog(jobPostId, "Generation stopped by user");
        showRegenNotice("Generation stopped.", "error", 2800);
      } else {
        const statusCode = Number(error && error.status);
        const rawError = String((error && error.message) || error || "");
        const rawLower = rawError.toLowerCase();
        if (statusCode === 403 || statusCode === 429) {
          appendRegenLog(jobPostId, `Rate limited or blocked (${statusCode})`);
          showRegenNotice("Generation temporarily blocked (403/429). Please retry later.", "error", 4600);
        } else if (rawLower.includes("start-button-not-found") || rawLower.includes("repeat-button-not-found")) {
          appendRegenLog(jobPostId, "Generation failed: native start button not found");
          showRegenNotice("Could not find Create video/Repeat button on native page.", "error", 5200);
        } else if (rawLower.includes("repeat-clicked-but-not-triggered")) {
          appendRegenLog(jobPostId, "Generation failed: start button clicked but no generation request detected");
          showRegenNotice("Create video/Repeat was clicked but generation did not start.", "error", 5200);
        } else if (rawLower.includes("cloudflare-challenge-page") || rawLower.includes("cloudflare-or-auth-block")) {
          appendRegenLog(jobPostId, "Generation blocked by Cloudflare challenge/auth");
          showRegenNotice("Generation temporarily blocked (403/429). Please retry later.", "error", 4600);
        } else if (rawLower.includes("native-regen-timeout")) {
          appendRegenLog(jobPostId, "Generation failed: native page timeout");
          showRegenNotice("Generation timed out on native page.", "error", 5200);
        } else if (rawLower.includes("moderated")) {
          appendRegenLog(jobPostId, "Generation failed: moderation");
          showRegenNotice("Generation failed, likely due to NSFW moderation.", "error", 5200);
        } else if (rawLower.includes("regen-post-id-missing")) {
          appendRegenLog(jobPostId, "Generation failed: missing post id");
          showRegenNotice("Regeneration unavailable for this item.", "error", 4600);
        } else {
          appendRegenLog(jobPostId, `Generation failed: ${rawError}`);
          showRegenNotice("Generation failed.", "error", 5200);
        }
      }
    } finally {
      try {
        stopApiWatcher();
      } catch (error) {}
      job.running = false;
      job.abortController = null;
      syncThumbRegenIndicators(jobPostId);
      syncRegenOverlay();
      updateActionButtons();
      updateRegenDebugPanel();
    }
  };

  const showFloatingTooltip = (text, target, placement) => {
    if (!floatingTooltip || !text || !target) return;
    floatingTooltip.textContent = text;
    const rect = target.getBoundingClientRect();
    const left = rect.left + rect.width / 2;
    const placeTop = placement === "top";
    let top = rect.bottom + 8;
    floatingTooltip.style.transform = "translateX(-50%)";
    if (placeTop) {
      floatingTooltip.style.transform = "translate(-50%, -100%)";
      top = rect.top - 8;
    }
    floatingTooltip.style.left = `${left}px`;
    floatingTooltip.style.top = `${top}px`;
    floatingTooltip.classList.add("show");
  };

  const hideFloatingTooltip = () => {
    if (!floatingTooltip) return;
    floatingTooltip.classList.remove("show");
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

  const openSettingsModal = () => {
    if (!settingsModal) return;
    updateSettingsUI();
    settingsModal.classList.add("open");
    settingsModal.setAttribute("aria-hidden", "false");
  };

  const closeSettingsModal = () => {
    if (!settingsModal) return;
    settingsModal.classList.remove("open");
    settingsModal.setAttribute("aria-hidden", "true");
  };

  const updateModeSetupDoneUI = () => {
    if (!modeSetupDoneDot) return;
    modeSetupDoneDot.classList.toggle("show", !!state.settings.downloadSettingsGuideDone);
  };

  const maybePromptDownloadSetupGuide = () => {};

  const showDuplicateModal = (message, seconds = 10) => {
    if (!duplicateModal) return;
    const activeEl = document.activeElement;
    if (activeEl instanceof Element && !duplicateModal.contains(activeEl)) {
      duplicateModalPreviousFocus = activeEl;
    }
    duplicateAskActive = false;
    duplicateAskResolver = null;
    duplicateModal.removeAttribute("inert");
    if (duplicateYesBtn) duplicateYesBtn.style.display = "none";
    if (duplicateNoBtn) duplicateNoBtn.style.display = "none";
    if (duplicateMessageEl && message) duplicateMessageEl.textContent = message;
    if (duplicateTimerHandle) clearTimeout(duplicateTimerHandle);
    if (duplicateIntervalHandle) clearInterval(duplicateIntervalHandle);
    let secondsLeft = Math.max(1, Number(seconds) || 10);
    if (duplicateTimerEl) duplicateTimerEl.textContent = String(secondsLeft);
    duplicateIntervalHandle = setInterval(() => {
      secondsLeft -= 1;
      if (duplicateTimerEl) duplicateTimerEl.textContent = secondsLeft > 0 ? String(secondsLeft) : "";
      if (secondsLeft <= 0 && duplicateIntervalHandle) {
        clearInterval(duplicateIntervalHandle);
        duplicateIntervalHandle = null;
      }
    }, 1000);
    duplicateTimerHandle = setTimeout(() => {
      hideDuplicateModal();
    }, Math.max(1, Number(seconds) || 10) * 1000);
    duplicateModal.classList.add("open");
    duplicateModal.setAttribute("aria-hidden", "false");
  };

  const askDuplicateModal = (message, seconds = 10) =>
    new Promise((resolve) => {
      if (!duplicateModal) {
        resolve(false);
        return;
      }
      duplicateAskActive = true;
      duplicateAskResolver = resolve;
      const activeEl = document.activeElement;
      if (activeEl instanceof Element && !duplicateModal.contains(activeEl)) {
        duplicateModalPreviousFocus = activeEl;
      }
      duplicateModal.removeAttribute("inert");
      if (duplicateMessageEl && message) duplicateMessageEl.textContent = message;
      if (duplicateYesBtn) duplicateYesBtn.style.display = "inline-flex";
      if (duplicateNoBtn) duplicateNoBtn.style.display = "inline-flex";
      if (duplicateTimerHandle) clearTimeout(duplicateTimerHandle);
      if (duplicateIntervalHandle) clearInterval(duplicateIntervalHandle);
      let secondsLeft = Math.max(1, Number(seconds) || 10);
      if (duplicateTimerEl) duplicateTimerEl.textContent = String(secondsLeft);
      duplicateIntervalHandle = setInterval(() => {
        secondsLeft -= 1;
        if (duplicateTimerEl) duplicateTimerEl.textContent = secondsLeft > 0 ? String(secondsLeft) : "";
        if (secondsLeft <= 0 && duplicateIntervalHandle) {
          clearInterval(duplicateIntervalHandle);
          duplicateIntervalHandle = null;
        }
      }, 1000);
      duplicateTimerHandle = setTimeout(() => {
        if (duplicateAskActive && duplicateAskResolver) {
          const resolver = duplicateAskResolver;
          duplicateAskResolver = null;
          duplicateAskActive = false;
          resolver(false);
        }
        hideDuplicateModal();
      }, Math.max(1, Number(seconds) || 10) * 1000);
      duplicateModal.classList.add("open");
      duplicateModal.setAttribute("aria-hidden", "false");
      const focusTarget = duplicateYesBtn || duplicateNoBtn || duplicateClose;
      if (focusTarget && typeof focusTarget.focus === "function") {
        setTimeout(() => {
          try {
            focusTarget.focus({ preventScroll: true });
          } catch (error) {
            try {
              focusTarget.focus();
            } catch (e) {}
          }
        }, 0);
      }
    });

  const hideDuplicateModal = () => {
    if (!duplicateModal) return;
    if (duplicateAskActive && duplicateAskResolver) {
      const resolver = duplicateAskResolver;
      duplicateAskResolver = null;
      duplicateAskActive = false;
      resolver(false);
    }
    if (duplicateTimerHandle) {
      clearTimeout(duplicateTimerHandle);
      duplicateTimerHandle = null;
    }
    if (duplicateIntervalHandle) {
      clearInterval(duplicateIntervalHandle);
      duplicateIntervalHandle = null;
    }
    if (duplicateYesBtn) duplicateYesBtn.style.display = "none";
    if (duplicateNoBtn) duplicateNoBtn.style.display = "none";
    if (duplicateTimerEl) duplicateTimerEl.textContent = "";
    const safeFocusFallback = refreshBtn || settingsBtn || viewModeBtn || githubBtn || appEl || null;
    const restoreTarget =
      duplicateModalPreviousFocus &&
      typeof duplicateModalPreviousFocus.focus === "function" &&
      duplicateModalPreviousFocus.isConnected &&
      !duplicateModal.contains(duplicateModalPreviousFocus)
        ? duplicateModalPreviousFocus
        : safeFocusFallback;
    const activeEl = document.activeElement;
    if (activeEl && typeof duplicateModal.contains === "function" && duplicateModal.contains(activeEl)) {
      try {
        if (typeof activeEl.blur === "function") activeEl.blur();
      } catch (error) {}
    }
    if (restoreTarget && typeof restoreTarget.focus === "function") {
      try {
        restoreTarget.focus({ preventScroll: true });
      } catch (error) {
        try {
          restoreTarget.focus();
        } catch (e) {}
      }
    }
    requestAnimationFrame(() => {
      duplicateModal.classList.remove("open");
      duplicateModal.setAttribute("aria-hidden", "true");
      duplicateModal.setAttribute("inert", "");
    });
    duplicateModalPreviousFocus = null;
  };

  const closePromptChoiceModal = (result) => {
    if (promptChoiceTimer) {
      clearTimeout(promptChoiceTimer);
      promptChoiceTimer = null;
    }
    if (promptChoiceAskResolver) {
      const resolver = promptChoiceAskResolver;
      promptChoiceAskResolver = null;
      resolver(result || null);
    }
    if (!promptChoiceModal) return;
    const activeEl = document.activeElement;
    if (activeEl && typeof promptChoiceModal.contains === "function" && promptChoiceModal.contains(activeEl)) {
      try {
        if (typeof activeEl.blur === "function") activeEl.blur();
      } catch (error) {}
    }
    const fallbackFocus = promptBtn || refreshBtn || settingsBtn || viewModeBtn || githubBtn || appEl || null;
    const restoreTarget =
      promptChoiceModalPreviousFocus &&
      typeof promptChoiceModalPreviousFocus.focus === "function" &&
      promptChoiceModalPreviousFocus.isConnected &&
      !promptChoiceModal.contains(promptChoiceModalPreviousFocus)
        ? promptChoiceModalPreviousFocus
        : fallbackFocus;
    if (restoreTarget && typeof restoreTarget.focus === "function") {
      try {
        restoreTarget.focus({ preventScroll: true });
      } catch (error) {
        try {
          restoreTarget.focus();
        } catch (e) {}
      }
    }
    requestAnimationFrame(() => {
      promptChoiceModal.classList.remove("open");
      promptChoiceModal.setAttribute("aria-hidden", "true");
      promptChoiceModal.setAttribute("inert", "");
    });
    promptChoiceModalPreviousFocus = null;
  };

  const askPromptChoiceModal = () =>
    new Promise((resolve) => {
      if (!promptChoiceModal) {
        resolve("copy");
        return;
      }
      if (promptChoiceAskResolver) {
        resolve(null);
        return;
      }
      const activeEl = document.activeElement;
      if (activeEl instanceof Element && !promptChoiceModal.contains(activeEl)) {
        promptChoiceModalPreviousFocus = activeEl;
      }
      promptChoiceAskResolver = resolve;
      promptChoiceModal.removeAttribute("inert");
      promptChoiceModal.classList.add("open");
      promptChoiceModal.setAttribute("aria-hidden", "false");
      const focusTarget = promptChoiceCopyBtn || promptChoiceDownloadBtn || promptChoiceClose || null;
      if (focusTarget && typeof focusTarget.focus === "function") {
        setTimeout(() => {
          try {
            focusTarget.focus({ preventScroll: true });
          } catch (error) {
            try {
              focusTarget.focus();
            } catch (e) {}
          }
        }, 0);
      }
      promptChoiceTimer = setTimeout(() => {
        closePromptChoiceModal("copy");
      }, 30000);
    });

  const updateSettingsUI = () => {
    const mode = getDownloadMode();
    if (dlModeAsk) dlModeAsk.checked = mode === "ask_each";
    if (dlModeFolder) dlModeFolder.checked = mode === "folder_once";
    if (dlModeAuto) dlModeAuto.checked = mode === "default_auto";
    if (dlModeFolder) dlModeFolder.disabled = false;
    if (folderHintEl) {
      const folderText = getFolderDisplayValue();
      if (!supportsFolderHandles()) {
        folderHintEl.textContent =
          mode === "folder_once" && folderText
            ? `Downloads go to one folder in your Downloads directory - ${folderText}`
            : "Choose a folder name from your Downloads directory and keep using it.";
      } else {
        folderHintEl.textContent =
          mode === "folder_once" && folderText
            ? `Downloads go to one folder in your Downloads directory - ${folderText}`
            : "Downloads go to one folder in your Downloads directory.";
      }
    }
    if (changeFolderBtn) {
      changeFolderBtn.style.display = mode === "folder_once" ? "inline-flex" : "none";
    }
    const bulk = getBulkTarget();
    if (bulk32Btn) bulk32Btn.classList.toggle("active", bulk === 32);
    if (bulk64Btn) bulk64Btn.classList.toggle("active", bulk === 64);
    if (bulk120Btn) bulk120Btn.classList.toggle("active", bulk === 120);
    if (autoRefreshAlwaysCheck) autoRefreshAlwaysCheck.checked = !!state.settings.autoRefreshAlways;
  };

  const setDownloadMode = async (mode) => {
    if (mode !== "ask_each" && mode !== "folder_once" && mode !== "default_auto") return;
    const previousMode = getDownloadMode();
    const previousFolder = sanitizeFolderPath(state.settings.folderPath || "");
    if (previousMode === mode && mode !== "folder_once") {
      updateSettingsUI();
      return;
    }
    if (mode === "folder_once") {
      const forcePick = !supportsFolderHandles();
      const ok = await pickFolderAndEnableMode(forcePick);
      if (!ok) {
        state.settings.downloadMode = previousMode;
        state.settings.folderPath = previousFolder;
        persistSettings();
        updateSettingsUI();
        setStatus("Folder selection canceled.");
      }
      return;
    }
    state.settings.downloadMode = mode;
    persistSettings();
    updateSettingsUI();
  };

  const setBulkTarget = (value) => {
    const parsed = Number(value);
    const target = parsed === 64 || parsed === 120 ? parsed : 32;
    state.settings.bulkTarget = target;
    persistSettings();
    updateSettingsUI();
  };

  const showViewModeModal = () => {
    if (!viewModeModal) return;
    const activeEl = document.activeElement;
    if (activeEl instanceof Element && !viewModeModal.contains(activeEl)) {
      viewModeModalPreviousFocus = activeEl;
    }
    viewModeModal.removeAttribute("inert");
    viewModeModal.classList.add("open");
    viewModeModal.setAttribute("aria-hidden", "false");
    if (appEl) appEl.classList.add("hidden");
    const preferredBtn = state.viewMode === "grid" ? modeNormalBtn : modeGridBtn;
    setTimeout(() => {
      if (preferredBtn && typeof preferredBtn.focus === "function") preferredBtn.focus({ preventScroll: true });
    }, 0);
  };

  const hideViewModeModal = () => {
    if (!viewModeModal) return;
    const activeEl = document.activeElement;
    if (activeEl instanceof Element && viewModeModal.contains(activeEl)) {
      try {
        activeEl.blur();
      } catch (error) {}
    }
    viewModeModal.classList.remove("open");
    viewModeModal.setAttribute("aria-hidden", "true");
    viewModeModal.setAttribute("inert", "");
    if (appEl) appEl.classList.remove("hidden");
    const fallbackFocus = viewModeBtn && typeof viewModeBtn.focus === "function" ? viewModeBtn : null;
    const restoreTarget =
      viewModeModalPreviousFocus &&
      typeof viewModeModalPreviousFocus.focus === "function" &&
      viewModeModalPreviousFocus.isConnected
        ? viewModeModalPreviousFocus
        : fallbackFocus;
    if (restoreTarget && typeof restoreTarget.focus === "function") {
      setTimeout(() => {
        try {
          restoreTarget.focus({ preventScroll: true });
        } catch (error) {}
      }, 0);
    }
    viewModeModalPreviousFocus = null;
  };

  const setViewMode = (mode, persist) => {
    if (mode !== "grid" && mode !== "normal") return;
    state.viewMode = mode;
    if (mode !== "grid") state.autoAdvanceAll = false;
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
    if (viewModeLabel) {
      viewModeLabel.textContent = mode === "grid" ? "Grid Mode Enabled" : "Normal Mode Enabled";
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

  const getPromptTextForItem = (item) => {
    const target = resolveActiveItem(item) || item;
    if (!target) return "";
    const fromTarget = target.promptText ? String(target.promptText).trim() : "";
    if (fromTarget) return fromTarget;
    if (item && item.variants && item.variants.length) {
      for (let i = 0; i < item.variants.length; i += 1) {
        const variant = item.variants[i];
        const variantPrompt = variant && variant.promptText ? String(variant.promptText).trim() : "";
        if (variantPrompt) return variantPrompt;
      }
    }
    return "";
  };

  const copyPromptItem = async (item, promptOverride, context = null) => {
    if (promptCopyAudio) {
      try {
        promptCopyAudio.currentTime = 0;
        const playPromise = promptCopyAudio.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      } catch (error) {}
    }
    const prompt = promptOverride || getPromptTextForItem(item);
    if (!prompt) {
      if (promptErrorAudio) {
        try {
          promptErrorAudio.currentTime = 0;
          const playPromise = promptErrorAudio.play();
          if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        } catch (error) {}
      }
      showPromptInlineFeedback("Prompt unavailable", "error", context || {});
      return;
    }
    await copyToClipboard(prompt);
    showPromptInlineFeedback("Prompt copied", "", context || {});
  };

  const handlePromptItem = async (item, context = null) => {
    const prompt = getPromptTextForItem(item);
    if (!prompt) {
      if (promptErrorAudio) {
        try {
          promptErrorAudio.currentTime = 0;
          const playPromise = promptErrorAudio.play();
          if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        } catch (error) {}
      }
      showPromptInlineFeedback("Prompt unavailable", "error", context || {});
      return;
    }
    const choice = await askPromptChoiceModal();
    if (choice === "download") {
      await downloadPromptInfoFile(item);
      return;
    }
    await copyPromptItem(item, prompt, context || {});
  };

  const playActionAudio = (action) => {
    let audio = null;
    if (action === "download") audio = downloadClickAudio;
    if (action === "share") audio = shareClickAudio;
    if (action === "delete") audio = closeClickAudio;
    if (!audio) return;
    try {
      audio.currentTime = 0;
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
    } catch (error) {}
  };

  const applyModeUI = () => {
    const isImages = state.mode === "images";
    if (tabVideosBtn) tabVideosBtn.classList.toggle("active", !isImages);
    if (tabImagesBtn) tabImagesBtn.classList.toggle("active", isImages);
    if (autoNextBtn) autoNextBtn.style.display = isImages ? "none" : "";
    if (downloadAllBtn) downloadAllBtn.textContent = "Download All";
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
    if (downloadBtn) downloadBtn.dataset.tooltip = isImages ? "Download this image only" : "Download this video only";
    if (shareBtn) shareBtn.dataset.tooltip = isImages ? "Receive a link for this image" : "Receive a link for this video";
    if (deleteBtn) deleteBtn.dataset.tooltip = isImages ? "Delete this image" : "Delete this video";
    if (promptBtn) promptBtn.dataset.tooltip = "Copy this prompt";
    if (regenBtn) regenBtn.dataset.tooltip = "Generate an alternative video from this prompt";
    if (autoNextBtn) autoNextBtn.dataset.tooltip = "All your videos will play automatically";
    if (downloadGroupBtn) downloadGroupBtn.dataset.tooltip = "Download only this compilation";
    updateRegenButtonVisual();
    if (sortBtn) {
      sortBtn.style.display = "";
      sortBtn.textContent = state.sortOrder === "asc" ? "Sort by new" : "Sort by old";
    }
    if (hideModToastWrap) hideModToastWrap.style.display = isImages ? "none" : "";
    if (footerEl) footerEl.style.display = "grid";
  };

  const setMode = (mode) => {
    if (mode !== "videos" && mode !== "images") return;
    if (state.mode === mode) return;
    state.mode = mode;
    if (mode === "images") state.autoAdvanceAll = false;
    state.selectedIndex = 0;
    applyModeUI();
    updateActionButtons();
    ensurePageData(mode, state.pageByMode[mode] || 0);
  };

  const updateActionButtons = () => {
    const selected = state.items[state.selectedIndex];
    const activeItem = resolveActiveItem(selected);
    const activePostId = activeItem && activeItem.postId ? String(activeItem.postId).trim() : "";
    if (activePostId) regenState.activePostId = activePostId;
    const canDelete = Boolean(activeItem && activeItem.postId);
    const isImages = state.mode === "images";
    const regenContext = selected ? buildRegenContext(selected, null) : null;
    const activeJob = getRegenJob(activePostId);
    const activeRunning = Boolean(activeJob && activeJob.running);
    const runningCount = getRunningRegenCount();
    const cooldownSeconds = getRegenCooldownSeconds();
    const cooldownBlocked = cooldownSeconds > 0 && runningCount === 0;
    if (downloadBtn) downloadBtn.disabled = !activeItem || state.busy;
    if (shareBtn) shareBtn.disabled = !activeItem || !activeItem.postId || state.busy;
    if (deleteBtn) deleteBtn.disabled = !canDelete || state.busy;
    if (promptBtn) promptBtn.disabled = !activeItem || state.busy;
    if (regenBtn) {
      const canRegenerate = Boolean(regenContext && regenContext.message && regenContext.parentPostId);
      const slotBlocked = !activeRunning && runningCount >= REGEN_MAX_CONCURRENT;
      regenBtn.disabled = !canRegenerate || state.busy || activeRunning || cooldownBlocked || slotBlocked;
      regenBtn.classList.toggle("active", activeRunning);
      if (activeRunning) {
        const pct = Math.max(0, Math.min(100, Math.round(Number(activeJob && activeJob.progress) || 0)));
        regenBtn.dataset.tooltip = `Regeneration in progress (${pct}%)`;
      } else if (slotBlocked) {
        regenBtn.dataset.tooltip = `Maximum ${REGEN_MAX_CONCURRENT} regenerations in progress`;
      } else if (cooldownBlocked) {
        regenBtn.dataset.tooltip = `Regenerate available in ${cooldownSeconds}s`;
      } else {
        regenBtn.dataset.tooltip = "Generate an alternative video from this prompt";
      }
      updateRegenButtonVisual();
    }
    if (downloadAllBtn) {
      const hasItems = isImages ? state.imageItems.length : state.videoItems.length;
      downloadAllBtn.disabled = !hasItems || state.busy;
    }
    if (deleteAllBtn) {
      const hasItems = isImages ? state.imageItems.length : state.videoItems.length;
      const currentDeleteRunning = isDeleteAllRunning(state.mode);
      deleteAllBtn.disabled = !hasItems || currentDeleteRunning || (state.busy && !isBusyFromDeleteOnly());
    }
    if (autoNextBtn) autoNextBtn.classList.toggle("active", !isImages && state.autoAdvance);
    if (autoAllBtn) {
      const showAllAutoplay = isGridMode() && !isImages;
      autoAllBtn.style.display = showAllAutoplay ? "inline-flex" : "none";
      autoAllBtn.classList.toggle("active", showAllAutoplay && state.autoAdvanceAll);
      autoAllBtn.disabled = !showAllAutoplay || state.busy;
    }
    if (downloadGroupBtn) {
      const showGroup = isGridMode() && selected && selected.variants && selected.variants.length > 1;
      downloadGroupBtn.style.display = "inline-flex";
      downloadGroupBtn.disabled = !showGroup || state.busy;
    }
    updateLightboxAutoplayIcon();
    updateAutoplayAllIcon();
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

  const escapeSelectorValue = (value) => {
    const text = String(value || "");
    if (!text) return "";
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(text);
    }
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  };

  const animateThumbRemoval = (postId) => {
    const id = String(postId || "").trim();
    if (!id || !gridEl) return;
    const escaped = escapeSelectorValue(id);
    if (!escaped) return;
    const thumbs = gridEl.querySelectorAll(`.thumb[data-post-id="${escaped}"]`);
    for (let i = 0; i < thumbs.length; i += 1) {
      const thumb = thumbs[i];
      if (!thumb || !thumb.isConnected) continue;
      thumb.classList.add("removing");
      const card = thumb.closest(".thumb-card");
      if (card) {
        card.classList.add("removing");
        setTimeout(() => {
          if (card && card.isConnected) card.remove();
        }, 230);
      } else {
        setTimeout(() => {
          if (thumb && thumb.isConnected) thumb.remove();
        }, 230);
      }
    }
  };

  const applyThumbRegenState = (thumb) => {
    if (!thumb) return;
    const postId = String((thumb.dataset && thumb.dataset.postId) || "").trim();
    const indicator = thumb.querySelector(".thumb-regen-mini");
    const indicatorText = indicator ? indicator.querySelector(".thumb-regen-mini-text") : null;
    const job = getRegenJob(postId);
    const running = Boolean(job && job.running);
    thumb.classList.toggle("regen-running", running);
    if (!indicator) return;
    if (!running) {
      indicator.style.setProperty("--regen-pct", "0");
      if (indicatorText) indicatorText.textContent = "";
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
    indicator.style.setProperty("--regen-pct", String(pct));
    if (indicatorText) indicatorText.textContent = String(pct);
  };

  const syncThumbRegenIndicators = (postId) => {
    if (!gridEl) return;
    const key = String(postId || "").trim();
    if (key) {
      const escaped = escapeSelectorValue(key);
      if (!escaped) return;
      const thumbs = gridEl.querySelectorAll(`.thumb[data-post-id="${escaped}"]`);
      for (let i = 0; i < thumbs.length; i += 1) {
        applyThumbRegenState(thumbs[i]);
      }
      return;
    }
    const allThumbs = gridEl.querySelectorAll(".thumb");
    for (let i = 0; i < allThumbs.length; i += 1) {
      applyThumbRegenState(allThumbs[i]);
    }
  };

  let autoplayBatchTimer = 0;
  let autoplayRunToken = 0;

  const stopAutoplayBatch = () => {
    autoplayRunToken += 1;
    if (autoplayBatchTimer) {
      clearTimeout(autoplayBatchTimer);
      autoplayBatchTimer = 0;
    }
  };

  const syncThumbAutoplayPlayback = () => {
    if (!gridEl) return;
    const videos = Array.from(gridEl.querySelectorAll(".thumb video"));
    stopAutoplayBatch();
    if (!state.thumbAutoplay) {
      videos.forEach((el) => {
        if (!el) return;
        try {
          el.pause();
        } catch (e) {}
      });
      return;
    }

    const token = ++autoplayRunToken;
    const batchSize = 6;
    let index = 0;
    const playBatch = () => {
      if (!state.thumbAutoplay || token !== autoplayRunToken) return;
      const end = Math.min(index + batchSize, videos.length);
      for (; index < end; index += 1) {
        const el = videos[index];
        if (!el || !el.isConnected) continue;
        const src = el.dataset.src || "";
        if (src && !el.src) {
          el.src = src;
        }
        const p = el.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
      if (index < videos.length) {
        autoplayBatchTimer = window.setTimeout(playBatch, 12);
      } else {
        autoplayBatchTimer = 0;
      }
    };
    playBatch();
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
    const chunkSize = 36;
    let index = 0;
    const renderChunk = () => {
      if (token !== state.renderToken) return;
      const fragment = document.createDocumentFragment();
      const sliceEnd = Math.min(index + chunkSize, items.length);
      for (; index < sliceEnd; index += 1) {
        const item = items[index];
        const displayItem = resolveActiveItem(item) || item;
        const isNewGenerationItem = hasNewGenerationHighlight(item, displayItem);
        const eagerThumb = index < 24;
        const card = document.createElement("div");
        card.className = "thumb-card";
        card.dataset.index = String(index);
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.dataset.index = String(index);
        if (displayItem && displayItem.postId) thumb.dataset.postId = displayItem.postId;
        if (isNewGenerationItem) {
          thumb.classList.add("new-generation");
          const newRibbon = document.createElement("span");
          newRibbon.className = "thumb-new-ribbon";
          newRibbon.textContent = "NEW";
          thumb.appendChild(newRibbon);
        }
        if (mode === "videos") {
          if (isHdVideoItem(displayItem)) {
            const hdTag = document.createElement("span");
            hdTag.className = "thumb-hd-tag";
            hdTag.textContent = "HD";
            thumb.appendChild(hdTag);
          } else {
            queueHdProbe(displayItem);
          }
        }
        thumb.setAttribute("role", "button");
        thumb.tabIndex = 0;

        if (mode === "images") {
          const img = document.createElement("img");
          img.src = optimizeThumbUrl(displayItem.url, { imageGridLow: true });
          img.alt = "Generated image";
          img.loading = eagerThumb ? "eager" : "lazy";
          img.fetchPriority = eagerThumb ? "high" : "auto";
          img.decoding = "async";
          thumb.appendChild(img);
        } else if (state.thumbAutoplay) {
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.preload = eagerThumb ? "metadata" : "none";
          video.loop = true;
          video.autoplay = false;
          video.tabIndex = -1;
          video.dataset.index = String(index);
          const fastPoster = getBestPosterUrl(displayItem, { preferSource: true });
          if (fastPoster && !isMp4(fastPoster, displayItem.mimeType)) video.poster = fastPoster;
          const thumbSource = optimizeThumbUrl(displayItem.url);
          if (eagerThumb) {
            video.src = thumbSource;
          } else {
            video.dataset.src = thumbSource;
          }
          video.addEventListener("error", () => addLog(`Thumb error: ${displayItem.url}`));
          thumb.appendChild(video);
        } else {
          const img = document.createElement("img");
          const fastPoster = getBestPosterUrl(displayItem, { preferSource: isNewGenerationItem });
          if (fastPoster && !isMp4(fastPoster, displayItem.mimeType)) {
            img.src = fastPoster;
            img.alt = "Generated video";
            img.loading = eagerThumb ? "eager" : "lazy";
            img.fetchPriority = eagerThumb ? "high" : "auto";
            img.decoding = "async";
            img.onerror = () => {
              const sourceFirstFallback = getBestPosterUrl(displayItem, { preferSource: true });
              if (!img.dataset.fallback && sourceFirstFallback && sourceFirstFallback !== img.src) {
                img.dataset.fallback = "1";
                img.src = sourceFirstFallback;
                return;
              }
              if (img.dataset.videoFallback) return;
              img.dataset.videoFallback = "1";
              const video = document.createElement("video");
              video.muted = true;
              video.playsInline = true;
              video.preload = "metadata";
              video.loop = false;
              video.autoplay = false;
              video.tabIndex = -1;
              video.src = optimizeThumbUrl(displayItem.url);
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
            video.src = optimizeThumbUrl(displayItem.url);
            video.addEventListener("loadeddata", () => {
              try {
                video.pause();
              } catch (e) {}
            });
            video.addEventListener("error", () => addLog(`Thumb error: ${displayItem.url}`));
            thumb.appendChild(video);
          }
        }

        const regenMini = document.createElement("div");
        regenMini.className = "thumb-regen-mini";
        const regenMiniText = document.createElement("span");
        regenMiniText.className = "thumb-regen-mini-text";
        regenMini.appendChild(regenMiniText);
        thumb.appendChild(regenMini);
        applyThumbRegenState(thumb);

        if (item && item.variants && item.variants.length > 1) {
          thumb.classList.add("has-group-badge");
          const badge = document.createElement("div");
          badge.className = "group-badge";
          thumb.appendChild(badge);
        }

        if (isItemDownloaded(mode, displayItem)) {
          const downloadedBadge = document.createElement("div");
          downloadedBadge.className = "downloaded-badge";
          downloadedBadge.textContent = "✓";
          downloadedBadge.dataset.tooltip = "File already downloaded";
          downloadedBadge.setAttribute("aria-label", "File already downloaded");
          thumb.appendChild(downloadedBadge);
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
        downloadAction.appendChild(buildIcon("images/thumbnail/download.svg", "Download"));
        downloadAction.dataset.action = "download";
        downloadAction.dataset.index = String(index);

        const shareAction = document.createElement("button");
        shareAction.type = "button";
        shareAction.className = "icon-btn share";
        shareAction.title = displayItem.postId ? "Share" : "Share unavailable";
        shareAction.dataset.tooltip = "Share";
        shareAction.appendChild(buildIcon("images/thumbnail/share.svg", "Share"));
        shareAction.dataset.action = "share";
        shareAction.dataset.index = String(index);
        if (!displayItem.postId || state.busy) shareAction.disabled = true;

        const deleteAction = document.createElement("button");
        deleteAction.type = "button";
        deleteAction.className = "icon-btn danger";
        deleteAction.title = displayItem.postId ? "Delete" : "Delete unavailable";
        deleteAction.dataset.tooltip = "Delete";
        deleteAction.appendChild(buildIcon("images/thumbnail/close.svg", "Delete"));
        deleteAction.dataset.action = "delete";
        deleteAction.dataset.index = String(index);
        if (!displayItem.postId || state.busy) deleteAction.disabled = true;

        const promptAction = document.createElement("button");
        promptAction.type = "button";
        promptAction.className = "icon-btn prompt";
        promptAction.title = "Copy this prompt";
        promptAction.dataset.tooltip = "Copy this prompt";
        promptAction.appendChild(buildIcon("images/prompt.svg", "Prompt"));
        promptAction.dataset.action = "prompt";
        promptAction.dataset.index = String(index);

        actions.appendChild(downloadAction);
        actions.appendChild(shareAction);
        actions.appendChild(deleteAction);
        actions.appendChild(promptAction);
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
      syncThumbAutoplayPlayback();
      updateActionButtons();
    };
    scheduleWork(renderChunk);
  };

  const ensureDownloadedBadgeForThumb = (thumb) => {
    if (!thumb) return;
    if (thumb.querySelector(".downloaded-badge")) return;
    const downloadedBadge = document.createElement("div");
    downloadedBadge.className = "downloaded-badge";
    downloadedBadge.textContent = "✓";
    downloadedBadge.dataset.tooltip = "File already downloaded";
    downloadedBadge.setAttribute("aria-label", "File already downloaded");
    thumb.appendChild(downloadedBadge);
  };

  const syncVisibleDownloadedBadges = () => {
    if (!gridEl) return;
    const mode = state.mode;
    const thumbs = gridEl.querySelectorAll(".thumb[data-index]");
    thumbs.forEach((thumbNode) => {
      const thumb = thumbNode instanceof HTMLElement ? thumbNode : null;
      if (!thumb) return;
      const idx = Number(thumb.dataset.index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.items.length) return;
      const group = state.items[idx];
      const displayItem = resolveActiveItem(group) || group;
      if (!displayItem) return;
      if (isItemDownloaded(mode, displayItem)) {
        ensureDownloadedBadgeForThumb(thumb);
      } else {
        const existing = thumb.querySelector(".downloaded-badge");
        if (existing) existing.remove();
      }
    });
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
      const variantPostId = String((variant && variant.postId) || "").trim();
      if (variantPostId) thumb.dataset.variantId = variantPostId;
      const variantIsNew = Boolean(variantPostId && newGenerationHighlightIds.has(variantPostId));
      if (variantIsNew) {
        thumb.classList.add("new-generation");
        const ribbon = document.createElement("span");
        ribbon.className = "variant-new-ribbon";
        ribbon.textContent = "NEW";
        thumb.appendChild(ribbon);
      }
      const previewInfo = resolveVariantPreview(variant, group);
      const preview = previewInfo.url;
      if (previewInfo.useVideo) {
        const vid = document.createElement("video");
        vid.muted = true;
        vid.playsInline = true;
        vid.autoplay = true;
        vid.loop = true;
        vid.preload = "metadata";
        vid.src = preview;
        const posterCandidate = optimizeThumbUrl(normalizeUrl((variant && (variant.poster || variant.sourceImageUrl)) || ""));
        if (posterCandidate && !isMp4(posterCandidate, variant && variant.mimeType)) {
          vid.poster = posterCandidate;
        }
        const playPromise = vid.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        thumb.appendChild(vid);
      } else {
        const img = document.createElement("img");
        img.src = preview;
        img.alt = "Variant";
        img.loading = "lazy";
        thumb.appendChild(img);
      }
      const num = document.createElement("div");
      num.className = "variant-num";
      num.textContent = String(displayIdx + 1);
      thumb.appendChild(num);
      thumb.onclick = () => {
        if (variantPostId) consumeNewGenerationHighlightForPostId(variantPostId);
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

  const mergeRefreshedVideoIntoItem = (targetItem, refreshed) => {
    if (!targetItem || !refreshed) return;
    if (refreshed.playbackUrl) targetItem.playbackUrl = refreshed.playbackUrl;
    if (refreshed.mediaUrl) targetItem.mediaUrl = refreshed.mediaUrl;
    if (refreshed.url) targetItem.url = refreshed.url;
    if (refreshed.hdMediaUrl) targetItem.hdMediaUrl = refreshed.hdMediaUrl;
    if (refreshed.poster) targetItem.poster = refreshed.poster;
    if (refreshed.sourceImageUrl) targetItem.sourceImageUrl = refreshed.sourceImageUrl;
    if (refreshed.mimeType && !targetItem.mimeType) targetItem.mimeType = refreshed.mimeType;
    if (refreshed.mediaWidth) targetItem.mediaWidth = refreshed.mediaWidth;
    if (refreshed.mediaHeight) targetItem.mediaHeight = refreshed.mediaHeight;
    if (refreshed.isPortrait !== null && refreshed.isPortrait !== undefined) {
      targetItem.isPortrait = refreshed.isPortrait;
    }
  };

  const loadPlayer = () => {
    ensureMediaPreconnect();
    const group = state.items[state.selectedIndex];
    if (!group) return;
    if (group && group.variants && group.variants.length) {
      if (!Number.isFinite(group.activeIndex) || group.activeIndex >= group.variants.length) {
        group.activeIndex = 0;
      }
    }
    const item = resolveActiveItem(group);
    if (!item) return;
    const clearPendingPlayerLoadHooks = () => {
      if (!clearPlayerLoadHooks) return;
      try {
        clearPlayerLoadHooks();
      } catch (error) {}
      clearPlayerLoadHooks = null;
    };
    const isImages = state.mode === "images" && item.url && isImage(item.url, item.mimeType);
    if (isImages) {
      clearPendingPlayerLoadHooks();
      if (lightboxEl) lightboxEl.classList.remove("gv-landscape-video");
      if (playerEl) {
        try {
          playerEl.pause();
        } catch (e) {}
        playerEl.removeAttribute("src");
        playerEl.removeAttribute("poster");
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
      clearPendingPlayerLoadHooks();
      if (lightboxEl) lightboxEl.classList.toggle("gv-landscape-video", isLandscapeMediaItem(item));
      const itemPostId = String(item.postId || "").trim();
      const isNewGenerationItem = Boolean(itemPostId && newGenerationHighlightIds.has(itemPostId));
      if (isNewGenerationItem && itemPostId && !hydratedNewVideoPosts.has(itemPostId)) {
        hydratedNewVideoPosts.add(itemPostId);
        fetchPostDetails(itemPostId)
          .then((detail) => {
            if (!detail) return;
            const refreshed = resolveRefreshedVideoItem(
              detail,
              itemPostId,
              item.parentPostId || "",
              item.sourceImageUrl || "",
              item.promptText || ""
            );
            if (!refreshed) return;
            mergeRefreshedVideoIntoItem(item, refreshed);
            const activeNow = resolveActiveItem(state.items[state.selectedIndex]);
            const activeNowId = String((activeNow && activeNow.postId) || "").trim();
            const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
            if (lightboxOpenNow && activeNowId && activeNowId === itemPostId) {
              loadPlayer();
            }
          })
          .catch(() => {
            hydratedNewVideoPosts.delete(itemPostId);
          });
      }
      const playbackCandidates = getPlaybackCandidates(item);
      const token = ++playerLoadToken;
      const primarySource = playbackCandidates[0] || "";
      let missingSourceRetryTimer = null;
      const clearMissingSourceRetry = () => {
        if (!missingSourceRetryTimer) return;
        clearTimeout(missingSourceRetryTimer);
        missingSourceRetryTimer = null;
      };
      if (!primarySource) {
        const posterFallback = getBestPosterUrl(item, { preferSource: true });
        if (posterFallback && !isMp4(posterFallback, item.mimeType)) {
          playerEl.poster = posterFallback;
        } else {
          playerEl.removeAttribute("poster");
        }
        playerEl.style.display = "";
        playerEl.controls = true;
        playerEl.preload = "auto";
        playerEl.playsInline = true;
        playerEl.setAttribute("fetchpriority", "high");
        if (itemPostId) {
          const retryMissingSource = async (attempt) => {
            if (token !== playerLoadToken) return;
            const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
            if (!lightboxOpenNow) return;
            const activeNow = resolveActiveItem(state.items[state.selectedIndex]);
            const activeNowId = String((activeNow && activeNow.postId) || "").trim();
            if (!activeNowId || activeNowId !== itemPostId) return;
            try {
              const detail = await fetchPostDetails(itemPostId);
              if (!detail || token !== playerLoadToken) return;
              const refreshed = resolveRefreshedVideoItem(
                detail,
                itemPostId,
                item.parentPostId || "",
                item.sourceImageUrl || "",
                item.promptText || ""
              );
              if (refreshed) {
                mergeRefreshedVideoIntoItem(item, refreshed);
              }
            } catch (error) {}
            if (token !== playerLoadToken) return;
            const refreshedCandidates = getPlaybackCandidates(item);
            if (refreshedCandidates.length) {
              loadPlayer();
              return;
            }
            if (attempt >= 18) return;
            missingSourceRetryTimer = setTimeout(() => {
              retryMissingSource(attempt + 1);
            }, 450);
          };
          retryMissingSource(0);
        }
        clearPlayerLoadHooks = () => {
          clearMissingSourceRetry();
        };
        return;
      }
      const prefersSourcePoster = isNewGenerationItem;
      const posterCandidate = getBestPosterUrl(item, { preferSource: prefersSourcePoster });
      if (posterCandidate && !isMp4(posterCandidate, item.mimeType)) {
        playerEl.poster = posterCandidate;
      } else {
        playerEl.removeAttribute("poster");
      }
      let candidateIndex = 0;
      let fallbackTimer = null;
      let sourceProbeTimer = null;
      let sourceProbeAttempts = 0;
      let progressWatchTimer = null;
      let stallNoProgressTicks = 0;
      let lastPlaybackTime = -1;
      let detailRefreshInFlight = false;
      let detailRefreshed = false;
      const clearSourceProbe = () => {
        if (!sourceProbeTimer) return;
        clearTimeout(sourceProbeTimer);
        sourceProbeTimer = null;
      };
      const clearProgressWatch = () => {
        if (!progressWatchTimer) return;
        clearInterval(progressWatchTimer);
        progressWatchTimer = null;
      };
      const applySource = (sourceUrl) => {
        if (!sourceUrl) return;
        playerEl.pause();
        const currentSrc = String(playerEl.currentSrc || playerEl.src || "");
        if (currentSrc !== sourceUrl) {
          playerEl.src = sourceUrl;
          playerEl.load();
        }
        playerEl.loop = !(state.autoAdvance || state.autoAdvanceAll);
        const playPromise = playerEl.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
      };
      const tryRefreshCurrentPostSources = async () => {
        if (detailRefreshed || detailRefreshInFlight || !itemPostId || token !== playerLoadToken) return;
        detailRefreshInFlight = true;
        try {
          const detail = await fetchPostDetails(itemPostId);
          if (!detail || token !== playerLoadToken) return;
          const refreshed = resolveRefreshedVideoItem(
            detail,
            itemPostId,
            item.parentPostId || "",
            item.sourceImageUrl || "",
            item.promptText || ""
          );
          if (!refreshed) return;
          mergeRefreshedVideoIntoItem(item, refreshed);
          const refreshedCandidates = getPlaybackCandidates(item);
          for (let i = 0; i < refreshedCandidates.length; i += 1) {
            if (!playbackCandidates.includes(refreshedCandidates[i])) {
              playbackCandidates.push(refreshedCandidates[i]);
            }
          }
          if (candidateIndex + 1 < playbackCandidates.length) {
            detailRefreshed = true;
            tryFallback();
            return;
          }
          const currentCandidate = playbackCandidates[Math.max(0, candidateIndex)] || playbackCandidates[0] || "";
          if (currentCandidate && playerEl && token === playerLoadToken && playerEl.readyState < 2) {
            const currentSrc = String(playerEl.currentSrc || playerEl.src || "");
            if (currentSrc !== currentCandidate) {
              applySource(currentCandidate);
            }
          }
        } catch (error) {
          // keep current source candidates
        } finally {
          detailRefreshInFlight = false;
        }
      };
      const tryFallback = () => {
        if (candidateIndex + 1 >= playbackCandidates.length) {
          tryRefreshCurrentPostSources();
          return;
        }
        candidateIndex += 1;
        applySource(playbackCandidates[candidateIndex]);
      };
      const scheduleSourceProbe = () => {
        if (!itemPostId) return;
        if (sourceProbeAttempts >= 20) return;
        clearSourceProbe();
        sourceProbeTimer = setTimeout(async () => {
          if (!playerEl || token !== playerLoadToken) return;
          if (playerEl.readyState >= 2) return;
          sourceProbeAttempts += 1;
          await tryRefreshCurrentPostSources();
          if (!playerEl || token !== playerLoadToken) return;
          if (playerEl.readyState < 2) {
            const currentCandidate = playbackCandidates[Math.max(0, candidateIndex)] || playbackCandidates[0] || "";
            if (currentCandidate) applySource(currentCandidate);
            scheduleSourceProbe();
          }
        }, 380);
      };
      const scheduleProgressWatch = () => {
        clearProgressWatch();
        progressWatchTimer = setInterval(() => {
          if (!playerEl || token !== playerLoadToken) {
            clearProgressWatch();
            return;
          }
          const lightboxOpenNow = Boolean(lightboxEl && lightboxEl.classList.contains("open"));
          if (!lightboxOpenNow) {
            clearProgressWatch();
            return;
          }
          if (playerEl.ended || playerEl.paused) {
            lastPlaybackTime = Number(playerEl.currentTime || 0);
            stallNoProgressTicks = 0;
            return;
          }
          const nowTime = Number(playerEl.currentTime || 0);
          if (nowTime > lastPlaybackTime + 0.04) {
            lastPlaybackTime = nowTime;
            stallNoProgressTicks = 0;
            return;
          }
          stallNoProgressTicks += 1;
          if (stallNoProgressTicks < 3) return;
          stallNoProgressTicks = 0;
          const currentCandidate = playbackCandidates[Math.max(0, candidateIndex)] || playbackCandidates[0] || "";
          if (currentCandidate) {
            applySource(currentCandidate);
          } else {
            tryFallback();
          }
        }, 480);
      };
      const onLoadedMetadata = () => {
        if (!playerEl || token !== playerLoadToken || !lightboxEl) return;
        const vw = Number(playerEl.videoWidth || 0);
        const vh = Number(playerEl.videoHeight || 0);
        if (vw > 0 && vh > 0) {
          lightboxEl.classList.toggle("gv-landscape-video", vw >= vh);
        }
      };
      const onLoadedData = () => {
        if (token !== playerLoadToken) return;
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        clearSourceProbe();
        lastPlaybackTime = Number(playerEl.currentTime || 0);
        stallNoProgressTicks = 0;
        scheduleProgressWatch();
      };
      const onError = () => {
        if (token !== playerLoadToken) return;
        tryFallback();
      };
      const onWaitingOrStalled = () => {
        if (token !== playerLoadToken || !playerEl) return;
        const playPromise = playerEl.play();
        if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
        scheduleSourceProbe();
      };
      playerEl.addEventListener("loadedmetadata", onLoadedMetadata);
      playerEl.addEventListener("loadeddata", onLoadedData);
      playerEl.addEventListener("error", onError);
      playerEl.addEventListener("waiting", onWaitingOrStalled);
      playerEl.addEventListener("stalled", onWaitingOrStalled);
      fallbackTimer = setTimeout(() => {
        if (!playerEl || token !== playerLoadToken) return;
        if (playerEl.readyState < 2) tryFallback();
      }, 320);
      clearPlayerLoadHooks = () => {
        if (!playerEl) return;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        clearMissingSourceRetry();
        clearSourceProbe();
        clearProgressWatch();
        playerEl.removeEventListener("loadedmetadata", onLoadedMetadata);
        playerEl.removeEventListener("loadeddata", onLoadedData);
        playerEl.removeEventListener("error", onError);
        playerEl.removeEventListener("waiting", onWaitingOrStalled);
        playerEl.removeEventListener("stalled", onWaitingOrStalled);
      };
      playerEl.style.display = "";
      playerEl.controls = true;
      playerEl.preload = "auto";
      playerEl.playsInline = true;
      playerEl.setAttribute("fetchpriority", "high");
      applySource(primarySource);
      scheduleSourceProbe();
    }
    updateCount();
    updateActionButtons();
    syncRegenOverlay();
    renderVariantStrip();
    updateLightboxAutoplayIcon();
    prewarmAroundCurrentSelection();
  };

  const toggleAutoAdvance = () => {
    state.autoAdvance = !state.autoAdvance;
    if (state.autoAdvance) state.autoAdvanceAll = false;
    spinAutoplayIcon();
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

  const stepAutoplayAll = () => {
    if (!isGridMode() || !state.items.length) return;
    const group = state.items[state.selectedIndex];
    if (group && group.variants && group.variants.length > 1) {
      const current = Number.isFinite(group.activeIndex) ? group.activeIndex : 0;
      if (current < group.variants.length - 1) {
        group.activeIndex = current + 1;
        loadPlayer();
        renderVariantStrip();
        return;
      }
    }
    state.selectedIndex = (state.selectedIndex + 1 + state.items.length) % state.items.length;
    const nextGroup = state.items[state.selectedIndex];
    if (nextGroup && nextGroup.variants && nextGroup.variants.length > 0) {
      nextGroup.activeIndex = 0;
    }
    loadPlayer();
  };

  const toggleAutoAdvanceAll = () => {
    if (!isGridMode() || state.mode === "images") return;
    state.autoAdvanceAll = !state.autoAdvanceAll;
    if (state.autoAdvanceAll) state.autoAdvance = false;
    if (playerEl) playerEl.loop = false;
    updateActionButtons();
  };

  const getCurrentGroup = () => state.items[state.selectedIndex] || null;

  const isNestedGroupActive = () => {
    const group = getCurrentGroup();
    return Boolean(isGridMode() && group && group.variants && group.variants.length > 1);
  };

  const updateLightboxAutoplayIcon = () => {
    if (!autoNextBtn) return;
    const img = autoNextBtn.querySelector("img");
    if (!img) return;
    const icon = isNestedGroupActive() ? "images/autoplay-nidification.svg" : "images/autoplay.svg";
    img.src = chrome.runtime.getURL(icon);
    autoNextBtn.dataset.tooltip = isNestedGroupActive()
      ? "Only this compilation will autoplay"
      : "All your videos will play automatically";
  };

  const updateAutoplayAllIcon = () => {
    if (!autoAllBtn) return;
    autoAllBtn.dataset.tooltip = "All your videos will autoplay";
    const img = autoAllBtn.querySelector("img");
    if (img) img.src = chrome.runtime.getURL("images/autoplay-full.svg");
  };

  const spinAutoplayIcon = () => {
    spinButtonIcon(autoNextBtn);
  };

  const spinPromptIcon = () => {
    spinButtonIcon(promptBtn);
  };

  const spinButtonIcon = (button) => {
    if (!button) return;
    const icon = button.querySelector("img, svg");
    if (!icon) return;
    icon.classList.remove("autoplay-spin");
    void icon.offsetWidth;
    icon.classList.add("autoplay-spin");
    window.setTimeout(() => {
      icon.classList.remove("autoplay-spin");
    }, 500);
  };

  const openNestedGuideModal = () => {
    if (!nestedGuideModal) return;
    nestedGuideModal.classList.add("open");
    nestedGuideModal.setAttribute("aria-hidden", "false");
  };

  const closeNestedGuideModal = () => {
    if (!nestedGuideModal) return;
    nestedGuideModal.classList.remove("open");
    nestedGuideModal.setAttribute("aria-hidden", "true");
  };

  const maybeShowNestedGuide = () => {
    if (!isNestedGroupActive()) return;
    if (state.settings.skipNestedGuide || state.settings.nestedGuideShown) return;
    if (nestedGuideDontRemind) nestedGuideDontRemind.checked = !!state.settings.skipNestedGuide;
    openNestedGuideModal();
  };

  const openNormalGuideModal = () => {
    if (!normalGuideModal) return;
    normalGuideModal.classList.add("open");
    normalGuideModal.setAttribute("aria-hidden", "false");
  };

  const closeNormalGuideModal = () => {
    if (!normalGuideModal) return;
    normalGuideModal.classList.remove("open");
    normalGuideModal.setAttribute("aria-hidden", "true");
  };

  const maybeShowNormalGuide = () => {
    if (isGridMode()) return;
    if (state.settings.skipNormalGuide || state.settings.normalGuideShown) return;
    if (normalGuideDontRemind) normalGuideDontRemind.checked = !!state.settings.skipNormalGuide;
    openNormalGuideModal();
  };

  const openLightbox = (index) => {
    if (!lightboxEl) return;
    ensureMediaPreconnect();
    state.selectedIndex = (index + state.items.length) % state.items.length;
    const group = state.items[state.selectedIndex];
    if (group && group.variants && !Number.isFinite(group.activeIndex)) {
      group.activeIndex = 0;
    }
    lightboxEl.classList.add("open");
    lightboxEl.setAttribute("aria-hidden", "false");
    updateRegenButtonVisual();
    const activePostId = getSelectedRegenPostId();
    if (activePostId) regenState.activePostId = activePostId;
    updateRegenDebugPanel();
    syncRegenOverlay();
    prewarmAroundCurrentSelection();
    loadPlayer();
    const keepNestedRibbon = Boolean(isGridMode() && group && group.variants && group.variants.length > 1);
    if (!keepNestedRibbon) consumeNewGenerationHighlight(group);
    updateLightboxAutoplayIcon();
    if (isGridMode()) {
      maybeShowNestedGuide();
    } else {
      maybeShowNormalGuide();
    }
  };

  const closeLightbox = () => {
    if (!lightboxEl) return;
    clearLightboxPromptInlineNotice();
    lightboxEl.classList.remove("open");
    lightboxEl.classList.remove("gv-landscape-video");
    lightboxEl.setAttribute("aria-hidden", "true");
    closeNestedGuideModal();
    closeNormalGuideModal();
    if (clearPlayerLoadHooks) {
      try {
        clearPlayerLoadHooks();
      } catch (error) {}
      clearPlayerLoadHooks = null;
    }
    if (playerEl) {
      playerEl.pause();
      playerEl.removeAttribute("src");
      playerEl.load();
    }
    if (imageEl) {
      imageEl.style.display = "none";
      imageEl.removeAttribute("src");
    }
    setRegenOverlayVisible(false);
    hideRegenNotice();
    updateRegenDebugPanel();
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
    viewModeLabel = shadow.querySelector("#viewModeLabel");
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
    regenCreatedNoticeEl = shadow.querySelector("#regenCreatedNotice");
    if (downloadReadyEl) {
      downloadReadyEl.onclick = () => {
        openDownloadsFolder(lastDownloadFilename);
      };
    }
    downloadReadyAudio = new Audio(chrome.runtime.getURL("audio/1.mp3"));
    regenCreatedAudio = new Audio(chrome.runtime.getURL("audio/regeneration.mp3"));
    promptCopyAudio = new Audio(chrome.runtime.getURL("audio/prompt.mp3"));
    promptErrorAudio = new Audio(chrome.runtime.getURL("audio/wrong.wav"));
    downloadClickAudio = new Audio(chrome.runtime.getURL("audio/download.mp3"));
    shareClickAudio = new Audio(chrome.runtime.getURL("audio/share.mp3"));
    closeClickAudio = new Audio(chrome.runtime.getURL("audio/close.mp3"));
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
    promptBtn = shadow.querySelector("#promptBtn");
    regenBtn = shadow.querySelector("#regenBtn");
    autoNextBtn = shadow.querySelector("#autoNextBtn");
    downloadGroupBtn = shadow.querySelector("#downloadGroupBtn");
    autoAllBtn = shadow.querySelector("#autoAllBtn");
    prevBtn = shadow.querySelector("#prevBtn");
    nextBtn = shadow.querySelector("#nextBtn");
    playerEl = shadow.querySelector("#player");
    regenOverlayEl = shadow.querySelector("#regenOverlay");
    regenProgressTextEl = shadow.querySelector("#regenProgressText");
    regenProgressFillEl = shadow.querySelector("#regenProgressFill");
    regenStopBtn = shadow.querySelector("#regenStopBtn");
    regenNoticeEl = shadow.querySelector("#regenNotice");
    regenNoticeTextEl = shadow.querySelector("#regenNoticeText");
    regenNoticeCloseBtn = shadow.querySelector("#regenNoticeClose");
    regenDebugEl = shadow.querySelector("#regenDebug");
    regenDebugBodyEl = shadow.querySelector("#regenDebugBody");
    variantWrapEl = shadow.querySelector("#variantWrap");
    variantStripEl = shadow.querySelector("#variantStrip");
    variantMoreBtn = shadow.querySelector("#variantMoreBtn");
    const playerBox = shadow.querySelector(".gv-player-box");
    if (playerBox) {
      const img = document.createElement("img");
      img.id = "imagePlayer";
      img.alt = "Generated image";
      img.style.cssText = "display:none;border-radius:18px;";
      img.addEventListener("dblclick", () => {
        if (state.mode !== "images" || !imageEl) return;
        if (document.fullscreenElement) return;
        if (imageEl.requestFullscreen) {
          imageEl.requestFullscreen().catch(() => {});
        }
      });
      playerBox.appendChild(img);
      imageEl = img;
    }
    toastEl = shadow.querySelector("#toast");
    toastText = shadow.querySelector("#toastText");
    githubBtn = shadow.querySelector("#githubBtn");
    changelogModal = shadow.querySelector("#changelogModal");
    changelogClose = shadow.querySelector("#changelogClose");
    changelogGithub = shadow.querySelector("#changelogGithub");
    settingsModal = shadow.querySelector("#settingsModal");
    settingsClose = shadow.querySelector("#settingsClose");
    settingsBtn = shadow.querySelector("#settingsBtn");
    dlModeAsk = shadow.querySelector("#dlModeAsk");
    dlModeFolder = shadow.querySelector("#dlModeFolder");
    dlModeAuto = shadow.querySelector("#dlModeAuto");
    dlModeFolderRow = shadow.querySelector("#dlModeFolderRow");
    folderHintEl = shadow.querySelector("#folderHint");
    changeFolderBtn = shadow.querySelector("#changeFolderBtn");
    bulk32Btn = shadow.querySelector("#bulk32Btn");
    bulk64Btn = shadow.querySelector("#bulk64Btn");
    bulk120Btn = shadow.querySelector("#bulk120Btn");
    autoRefreshAlwaysCheck = shadow.querySelector("#autoRefreshAlways");
    duplicateModal = shadow.querySelector("#duplicateModal");
    duplicateClose = shadow.querySelector("#duplicateClose");
    duplicateMessageEl = shadow.querySelector("#duplicateMessage");
    duplicateTimerEl = shadow.querySelector("#duplicateTimer");
    duplicateYesBtn = shadow.querySelector("#duplicateYesBtn");
    duplicateNoBtn = shadow.querySelector("#duplicateNoBtn");
    promptChoiceModal = shadow.querySelector("#promptChoiceModal");
    promptChoiceClose = shadow.querySelector("#promptChoiceClose");
    promptChoiceCopyBtn = shadow.querySelector("#promptChoiceCopyBtn");
    promptChoiceDownloadBtn = shadow.querySelector("#promptChoiceDownloadBtn");
    nestedGuideModal = shadow.querySelector("#nestedGuideModal");
    nestedGuideOkBtn = shadow.querySelector("#nestedGuideOkBtn");
    nestedGuideDontRemind = shadow.querySelector("#nestedGuideDontRemind");
    normalGuideModal = shadow.querySelector("#normalGuideModal");
    normalGuideOkBtn = shadow.querySelector("#normalGuideOkBtn");
    normalGuideDontRemind = shadow.querySelector("#normalGuideDontRemind");
    viewModeModal = shadow.querySelector("#viewModeModal");
    modeGridBtn = shadow.querySelector("#modeGridBtn");
    modeNormalBtn = shadow.querySelector("#modeNormalBtn");
    modeDownloadSettingsBtn = shadow.querySelector("#modeDownloadSettingsBtn");
    modeSetupDoneDot = shadow.querySelector("#modeSetupDoneDot");
    modeDontRemind = shadow.querySelector("#modeDontRemind");
    if (viewModeModal) viewModeModal.setAttribute("inert", "");
    downloadProgressEl = shadow.querySelector("#downloadProgress");
    downloadProgressText = shadow.querySelector("#downloadProgressText");
    downloadProgressFill = shadow.querySelector("#downloadProgressFill");
    progressStopBtn = shadow.querySelector("#progressStopBtn");
    deleteDoneEl = shadow.querySelector("#deleteDone");
    floatingTooltip = shadow.querySelector("#floatingTooltip");
    setRegenOverlayVisible(false);
    if (regenProgressFillEl) regenProgressFillEl.style.setProperty("--regen-pct", "0");
    if (regenProgressTextEl) regenProgressTextEl.textContent = "0%";
    updateRegenDebugPanel();

    if (refreshBtn) refreshBtn.onclick = refresh;
    if (downloadAllBtn) downloadAllBtn.onclick = downloadAll;
    if (progressStopBtn) {
      progressStopBtn.onclick = () => {
        requestProgressCancel();
      };
    }
    if (deleteAllBtn) deleteAllBtn.onclick = deleteAll;
    if (downloadGroupBtn)
      downloadGroupBtn.onclick = () => {
        spinButtonIcon(downloadGroupBtn);
        downloadGroup();
      };
    if (gridEl) {
      gridEl.addEventListener("mouseover", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const tooltipNode = target.closest(".icon-btn, .downloaded-badge");
        if (!tooltipNode || !gridEl.contains(tooltipNode)) return;
        if (tooltipNode.classList.contains("icon-btn") && !tooltipNode.closest(".thumb-actions")) return;
        const text = tooltipNode.getAttribute("data-tooltip") || "";
        if (!text) return;
        showFloatingTooltip(text, tooltipNode, "bottom");
      });
      gridEl.addEventListener("mouseout", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const tooltipNode = target.closest(".icon-btn, .downloaded-badge");
        if (!tooltipNode) return;
        const related = event.relatedTarget;
        if (related instanceof Element && tooltipNode.contains(related)) return;
        hideFloatingTooltip();
      });
      gridEl.addEventListener("scroll", () => hideFloatingTooltip());
    }
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
          spinButtonIcon(actionBtn);
          if (action === "download") {
            playActionAudio("download");
            downloadFile(item);
          }
          if (action === "share") {
            playActionAudio("share");
            shareItem(item);
          }
          if (action === "delete") deleteItem(item);
          if (action === "prompt") handlePromptItem(item, { source: "thumb", trigger: actionBtn });
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
    if (downloadBtn)
      downloadBtn.onclick = () => {
        spinButtonIcon(downloadBtn);
        playActionAudio("download");
        downloadOne();
      };
    if (shareBtn)
      shareBtn.onclick = () => {
        const item = state.items[state.selectedIndex];
        spinButtonIcon(shareBtn);
        playActionAudio("share");
        if (item) shareItem(item);
      };
    if (deleteBtn)
      deleteBtn.onclick = () => {
        spinButtonIcon(deleteBtn);
        deleteOne();
      };
    if (promptBtn)
      promptBtn.onclick = () => {
        const item = state.items[state.selectedIndex];
        if (!item) return;
        spinPromptIcon();
        handlePromptItem(item, { source: "lightbox", trigger: promptBtn });
      };
    if (regenBtn)
      regenBtn.onclick = () => {
        startRegeneration();
      };
    if (regenStopBtn)
      regenStopBtn.onclick = () => {
        stopRegeneration("Stop pressed");
      };
    if (regenNoticeCloseBtn) {
      regenNoticeCloseBtn.onclick = () => hideRegenNotice();
    }
    if (autoNextBtn)
      autoNextBtn.onclick = () => {
        spinButtonIcon(autoNextBtn);
        toggleAutoAdvance();
      };
    if (autoAllBtn)
      autoAllBtn.onclick = () => {
        spinButtonIcon(autoAllBtn);
        toggleAutoAdvanceAll();
      };
    if (githubBtn) {
      githubBtn.onclick = () => {
        openChangelogModal();
      };
    }
    if (settingsBtn) settingsBtn.onclick = () => openSettingsModal();
    if (settingsClose) settingsClose.onclick = () => closeSettingsModal();
    if (settingsModal) {
      settingsModal.addEventListener("click", (event) => {
        if (event.target === settingsModal) closeSettingsModal();
      });
    }
    if (duplicateClose) duplicateClose.onclick = () => hideDuplicateModal();
    if (duplicateYesBtn) {
      duplicateYesBtn.onclick = () => {
        if (duplicateAskActive && duplicateAskResolver) {
          const resolver = duplicateAskResolver;
          duplicateAskResolver = null;
          duplicateAskActive = false;
          resolver(true);
        }
        hideDuplicateModal();
      };
    }
    if (duplicateNoBtn) {
      duplicateNoBtn.onclick = () => {
        if (duplicateAskActive && duplicateAskResolver) {
          const resolver = duplicateAskResolver;
          duplicateAskResolver = null;
          duplicateAskActive = false;
          resolver(false);
        }
        hideDuplicateModal();
      };
    }
    if (duplicateModal) {
      duplicateModal.addEventListener("click", (event) => {
        if (event.target === duplicateModal) hideDuplicateModal();
      });
    }
    if (promptChoiceClose) {
      promptChoiceClose.onclick = () => {
        closePromptChoiceModal(null);
      };
    }
    if (promptChoiceCopyBtn) {
      promptChoiceCopyBtn.onclick = () => {
        closePromptChoiceModal("copy");
      };
    }
    if (promptChoiceDownloadBtn) {
      promptChoiceDownloadBtn.onclick = () => {
        closePromptChoiceModal("download");
      };
    }
    if (promptChoiceModal) {
      promptChoiceModal.addEventListener("click", (event) => {
        if (event.target === promptChoiceModal) closePromptChoiceModal(null);
      });
    }
    if (nestedGuideOkBtn) {
      nestedGuideOkBtn.onclick = () => {
        state.settings.nestedGuideShown = true;
        if (nestedGuideDontRemind && nestedGuideDontRemind.checked) {
          state.settings.skipNestedGuide = true;
        }
        persistSettings();
        closeNestedGuideModal();
      };
    }
    if (nestedGuideModal) {
      nestedGuideModal.addEventListener("click", (event) => {
        if (event.target !== nestedGuideModal) return;
        state.settings.nestedGuideShown = true;
        persistSettings();
        closeNestedGuideModal();
      });
    }
    if (normalGuideOkBtn) {
      normalGuideOkBtn.onclick = () => {
        state.settings.normalGuideShown = true;
        if (normalGuideDontRemind && normalGuideDontRemind.checked) {
          state.settings.skipNormalGuide = true;
        }
        persistSettings();
        closeNormalGuideModal();
      };
    }
    if (normalGuideModal) {
      normalGuideModal.addEventListener("click", (event) => {
        if (event.target !== normalGuideModal) return;
        state.settings.normalGuideShown = true;
        persistSettings();
        closeNormalGuideModal();
      });
    }
    const dlModeAskRow = dlModeAsk && dlModeAsk.closest ? dlModeAsk.closest(".settings-row") : null;
    const dlModeAutoRow = dlModeAuto && dlModeAuto.closest ? dlModeAuto.closest(".settings-row") : null;
    if (dlModeAsk) {
      dlModeAsk.onchange = () => {
        setDownloadMode("ask_each");
      };
    }
    if (dlModeAuto) {
      dlModeAuto.onchange = () => {
        setDownloadMode("default_auto");
      };
    }
    if (dlModeFolder) {
      dlModeFolder.onchange = async () => {
        await setDownloadMode("folder_once");
      };
    }
    if (dlModeAskRow) {
      dlModeAskRow.onclick = (event) => {
        const target = event.target;
        if (target && target.closest && target.closest("input.settings-check")) return;
        setDownloadMode("ask_each");
      };
    }
    if (dlModeAutoRow) {
      dlModeAutoRow.onclick = (event) => {
        const target = event.target;
        if (target && target.closest && target.closest("input.settings-check")) return;
        setDownloadMode("default_auto");
      };
    }
    if (dlModeFolderRow) {
      dlModeFolderRow.onclick = async (event) => {
        const target = event.target;
        if (target && target.closest && target.closest("#changeFolderBtn")) return;
        if (target && target.closest && target.closest("input.settings-check")) return;
        await setDownloadMode("folder_once");
      };
    }
    if (changeFolderBtn) {
      changeFolderBtn.onclick = async () => {
        const ok = await pickFolderAndEnableMode(true);
        if (!ok) {
          setStatus("Folder selection canceled.");
          return;
        }
      };
    }
    if (bulk32Btn) bulk32Btn.onclick = () => setBulkTarget(32);
    if (bulk64Btn) bulk64Btn.onclick = () => setBulkTarget(64);
    if (bulk120Btn) bulk120Btn.onclick = () => setBulkTarget(120);
    if (autoRefreshAlwaysCheck) {
      autoRefreshAlwaysCheck.onchange = () => {
        state.settings.autoRefreshAlways = !!autoRefreshAlwaysCheck.checked;
        persistSettings();
        updateSettingsUI();
        updateAutoRefreshLoop();
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
    if (modeDownloadSettingsBtn) {
      modeDownloadSettingsBtn.onclick = async () => {
        state.settings.downloadSettingsGuideDone = true;
        persistSettings();
        updateModeSetupDoneUI();
        const response = await openDownloadSettingsPage();
        if (!response || !response.ok) {
          setStatus("Open browser download settings manually.");
        }
      };
    }
    if (modeDontRemind) {
      modeDontRemind.checked = !!state.settings.skipIntroModal;
      modeDontRemind.onchange = () => {
        state.settings.skipIntroModal = !!modeDontRemind.checked;
        persistSettings();
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
        spinButtonIcon(fullscreenBtn);
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
        if (state.mode === "images") return;
        if (isGridMode() && state.autoAdvanceAll) {
          stepAutoplayAll();
          return;
        }
        if (!state.autoAdvance) return;
        if (isNestedGroupActive()) {
          stepVariant(1);
          return;
        }
        step(1);
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
      if (promptChoiceModal && promptChoiceModal.classList.contains("open")) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePromptChoiceModal(null);
        }
        return;
      }
      if (!lightboxEl || !lightboxEl.classList.contains("open")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        stepVariant(1);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        stepVariant(-1);
      }
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
    await loadSettings();
    await loadDownloadedLookup();
    updateSettingsUI();
    updateAutoRefreshLoop();
    updateModeSetupDoneUI();
    setReadyStatus();
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
          viewModeBtn.dataset.tooltip = state.viewMode === "grid" ? "Return to normal mode" : "Return to Grid mode";
        }
      }
      if (modeDontRemind) modeDontRemind.checked = !!state.settings.skipIntroModal;
      if (state.settings.skipIntroModal) hideViewModeModal();
      else showViewModeModal();
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
          const keys = getVideoDedupKeys(item);
          keys.forEach((key) => {
            if (key) modeState.seen.add(key);
          });
        });
        modeState.totalLoaded = pageItems.length;
        modeState.maxPageLoaded = pageItems.length ? 0 : -1;
        updateItems();
        setReadyStatus();
      }
      refresh();
    });
  };

  initUI();
})();
