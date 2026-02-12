(() => {
  const STORAGE_KEY = "grokViewerVideos";
  const FAVORITES_URL = "https://grok.com/imagine/favorites";

  const statusEl = document.getElementById("status");
  const gridEl = document.getElementById("grid");
  const emptyEl = document.getElementById("empty");
  const countEl = document.getElementById("count");
  const refreshBtn = document.getElementById("refreshBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const deleteAllBtn = document.getElementById("deleteAllBtn");
  const githubBtn = document.getElementById("githubBtn");
  const purgeBtn = document.getElementById("purgeBtn");
  const hideModToastToggle = document.getElementById("hideModToastToggle");
  const logsBtn = document.getElementById("logsBtn");
  const logsPanel = document.getElementById("logsPanel");
  const logsBody = document.getElementById("logsBody");
  const clearLogsBtn = document.getElementById("clearLogsBtn");
  const toastEl = document.getElementById("toast");
  const toastText = document.getElementById("toastText");

  const lightboxEl = document.getElementById("lightbox");
  const lightboxCountEl = document.getElementById("lightboxCount");
  const closeBtn = document.getElementById("closeBtn");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const playerEl = document.getElementById("player");

  const state = {
    videos: [],
    selectedIndex: 0,
    favoritesTabId: null,
    busy: false,
    logsOpen: false,
    lastUpdatedAt: 0,
    knownUrls: new Set(),
  };

  const USE_BLOB_PROXY = false;
  const blobCache = new Map();
  const blobPending = new Map();

  let logTimer = null;
  const logLines = [];
  const MAX_LOGS = 200;

  const formatTime = (date) =>
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
      date.getSeconds()
    ).padStart(2, "0")}`;

  const addLog = () => {};

  const isPrivateUrl = (url) => typeof url === "string" && url.includes("assets.grok.com");

  const getBlobUrl = (url) => {
    if (blobCache.has(url)) return Promise.resolve(blobCache.get(url));
    if (blobPending.has(url)) return blobPending.get(url);
    const promise = fetch(url, { credentials: "include" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.blob();
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        blobCache.set(url, objectUrl);
        addLog(`Blob ready: ${url}`);
        return objectUrl;
      })
      .catch((error) => {
        const message = error && error.message ? error.message : "unknown";
        addLog(`Blob error (${message}): ${url}`);
        throw error;
      })
      .finally(() => {
        blobPending.delete(url);
      });
    blobPending.set(url, promise);
    return promise;
  };

  const clearBlobCache = () => {
    blobCache.forEach((value) => {
      URL.revokeObjectURL(value);
    });
    blobCache.clear();
    blobPending.clear();
  };

  const waitForTabReady = (tabId, timeoutMs = 2500) =>
    new Promise((resolve) => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resolve(false);
          return;
        }
        if (tab.status === "complete") {
          resolve(true);
          return;
        }
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(false);
        }, timeoutMs);
        const listener = (updatedId, info) => {
          if (updatedId !== tabId || info.status !== "complete") return;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    });

  const isMp4 = (url) => {
    if (!url || typeof url !== "string") return false;
    const base = url.split(/[?#]/)[0].toLowerCase();
    return base.endsWith(".mp4");
  };


  const setMode = () => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode") === "window" ? "window" : "popup";
    document.body.dataset.mode = mode;
  };

  const setStatus = (text) => {
    if (!statusEl) return;
    statusEl.textContent = text;
  };

  const updateCount = () => {
    const total = state.videos.length;
    if (countEl) {
      countEl.textContent = `${total} video${total === 1 ? "" : "s"}`;
    }
    if (lightboxCountEl) {
      const current = total ? state.selectedIndex + 1 : 0;
      lightboxCountEl.textContent = `${current} / ${total}`;
    }
  };

  const normalizeItems = (items) => {
    return (items || [])
      .filter((item) => item && item.url && isMp4(item.url))
      .map((item) => ({
        id: item.id || item.url,
        url: item.url,
        hdMediaUrl: item.hdMediaUrl || "",
        poster: item.poster || "",
        postId: item.postId || "",
        videoId: item.videoId || "",
        createdAt: item.createdAt || ""
      }));
  };

  const getSelected = () => state.videos[state.selectedIndex] || null;

  const getDownloadUrl = (item) => {
    if (!item) return "";
    return item.hdMediaUrl || item.url || "";
  };

  const buildFilename = (item, url) => {
    const fallback = `grok/video-${Date.now()}.mp4`;
    if (!url) return fallback;
    try {
      const parsed = new URL(url);
      const name = parsed.pathname.split("/").pop() || "video.mp4";
      const prefix = item && item.postId ? `grok/${item.postId}-` : "grok/";
      return `${prefix}${name}`;
    } catch (error) {
      return fallback;
    }
  };

  const downloadItem = (item) => {
    const url = getDownloadUrl(item);
    if (!url) return;
    const filename = buildFilename(item, url);
    if (chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download({ url, filename, saveAs: false }, () => {
        if (chrome.runtime.lastError) {
          const fallback = document.createElement("a");
          fallback.href = url;
          fallback.download = filename;
          fallback.target = "_blank";
          fallback.rel = "noreferrer";
          fallback.click();
        }
      });
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.click();
    }
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
    if (state.busy || !state.videos.length) return;
    state.busy = true;
    updateActionButtons();
    setStatus("Preparing archive...");
    try {
      const files = [];
      const queue = state.videos.slice();
      const concurrency = Math.min(4, Math.max(1, navigator.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 3));
      let completed = 0;

      const fetchOne = async () => {
        while (queue.length) {
          const item = queue.shift();
          if (!item) continue;
          const url = getDownloadUrl(item);
          if (!url) {
            completed += 1;
            continue;
          }
          const response = await fetch(url, { credentials: "include" });
          if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status}`);
          }
          const buffer = new Uint8Array(await response.arrayBuffer());
          const { dosTime, dosDate } = toDosTimeDate(new Date());
          const filename = buildFilename(item, url).replace(/^grok\//, "");
          files.push({
            name: filename,
            data: buffer,
            size: buffer.length,
            crc: crc32(buffer),
            dosTime,
            dosDate
          });
          completed += 1;
          setStatus(`Preparing archive... ${completed}/${state.videos.length}`);
        }
      };

      const workers = [];
      for (let i = 0; i < concurrency; i += 1) {
        workers.push(fetchOne());
      }
      await Promise.all(workers);

      if (!files.length) {
        setStatus("No videos available to download.");
        return;
      }
      setStatus("Building archive...");
      const blob = buildZipBlob(files);
      const archiveName = `grok-videos-${Date.now()}.zip`;
      const blobUrl = URL.createObjectURL(blob);
      if (chrome.downloads && chrome.downloads.download) {
        chrome.downloads.download({ url: blobUrl, filename: archiveName, saveAs: false }, () => {
          setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        });
      } else {
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = archiveName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      }
      setStatus("Archive download started.");
    } catch (error) {
      setStatus("Download all failed. Try again.");
    } finally {
      state.busy = false;
      updateActionButtons();
    }
  };

  const applyDeletion = (postIds) => {
    const ids = new Set((postIds || []).filter(Boolean));
    if (!ids.size) return;
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const items = (data && data[STORAGE_KEY] && data[STORAGE_KEY].items) || [];
      const filtered = items.filter((item) => !ids.has(item.postId));
      chrome.storage.local.set(
        {
          [STORAGE_KEY]: {
            items: filtered,
            updatedAt: Date.now()
          }
        },
        () => updateVideos(filtered, Date.now())
      );
    });
  };

  const sendToFavorites = (message, callback) => {
    chrome.tabs.query({ url: `${FAVORITES_URL}*` }, (tabs) => {
      const tab = tabs && tabs.length ? tabs[0] : null;
      state.favoritesTabId = tab ? tab.id : null;
      if (!state.favoritesTabId) {
        addLog("Favorites tab not found");
        callback({ ok: false, error: "no-tab" });
        return;
      }
      const needsInjectFile =
        message.action === "grokViewerDeleteOne" ||
        message.action === "grokViewerDeleteAll" ||
        message.action === "grokViewerFullSync";
      const injectFile = needsInjectFile ? "inject.js" : "favorites.js";
      const trySend = (attempt, injected) => {
        chrome.tabs.sendMessage(state.favoritesTabId, message, (response) => {
          if (!chrome.runtime.lastError) {
            addLog(`Message ok: ${message.action || "unknown"}`);
            callback({ ok: true, response });
            return;
          }
          const err = chrome.runtime.lastError.message || "";
          addLog(`Message error: ${err}`);
          const needsInject =
            !injected &&
            (err.includes("Receiving end does not exist") ||
              err.includes("Could not establish connection") ||
              err.includes("The message port closed"));
          if (needsInject && chrome.scripting && chrome.scripting.executeScript) {
            addLog(`Injecting ${injectFile} listener...`);
            chrome.scripting.executeScript(
              {
                target: { tabId: state.favoritesTabId },
                files: [injectFile]
              },
              () => {
                setTimeout(() => trySend(attempt + 1, true), 200);
              }
            );
            return;
          }
          if (attempt > 0) {
            callback({ ok: false, error: err });
            return;
          }
          setTimeout(() => trySend(attempt + 1, injected), 300);
        });
      };
      waitForTabReady(state.favoritesTabId).finally(() => trySend(0, false));
    });
  };

  const deleteItem = (item) => {
    if (!item || !item.postId || state.busy) return;
    state.busy = true;
    updateActionButtons();
    setStatus("Deleting video...");
    showToast("Deleting video...");
    setThumbStatus(item.postId, "deleting", "Deleting...");
    sendToFavorites({ action: "grokViewerDeleteOne", postId: item.postId }, (result) => {
      state.busy = false;
      updateActionButtons();
      if (!result.ok || !result.response || !result.response.ok) {
        setStatus("Delete failed. Keep favorites open.");
        showToast("Delete failed.", "error");
        setThumbStatus(item.postId, "failed", "Failed");
        return;
      }
      applyDeletion([item.postId]);
      setStatus("Video deleted.");
      showToast("DELETED");
    });
  };

  const deleteAll = () => {
    if (state.busy) return;
    const postIds = state.videos.map((item) => item.postId).filter(Boolean);
    if (!postIds.length) return;
    if (!window.confirm("Delete all videos from Grok favorites?")) return;
    state.busy = true;
    updateActionButtons();
    setStatus("Deleting all videos...");
    showToast("Deleting videos...");
    postIds.forEach((id) => setThumbStatus(id, "deleting", "Deleting..."));
    sendToFavorites({ action: "grokViewerDeleteAll", postIds }, (result) => {
      state.busy = false;
      updateActionButtons();
      if (!result.ok || !result.response || !result.response.ok) {
        setStatus("Delete all failed. Keep favorites open.");
        showToast("Delete failed.", "error");
        postIds.forEach((id) => setThumbStatus(id, "failed", "Failed"));
        return;
      }
      const deleted = result.response.deleted || postIds;
      applyDeletion(deleted);
      const failed = result.response.failed || [];
      if (failed.length) {
        setStatus(`Deleted ${postIds.length - failed.length}. Failed ${failed.length}.`);
        showToast("Some deletions failed.", "error");
        failed.forEach((id) => setThumbStatus(id, "failed", "Failed"));
      } else {
        setStatus("All deletions requested.");
        showToast("DELETED");
      }
    });
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


  const updateActionButtons = () => {
    const selected = getSelected();
    const canDelete = Boolean(selected && selected.postId);
    if (downloadBtn) downloadBtn.disabled = !selected || state.busy;
    if (deleteBtn) deleteBtn.disabled = !canDelete || state.busy;
    if (downloadAllBtn) downloadAllBtn.disabled = !state.videos.length || state.busy;
    if (deleteAllBtn) deleteAllBtn.disabled = !state.videos.some((item) => item.postId) || state.busy;
  };

  const renderGrid = () => {
    if (!gridEl) return;
    gridEl.innerHTML = "";

    if (!state.videos.length) {
      if (emptyEl) emptyEl.classList.add("show");
      updateCount();
      updateActionButtons();
      return;
    }

    if (emptyEl) emptyEl.classList.remove("show");

    const fragment = document.createDocumentFragment();
    state.videos.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "thumb-card";
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "thumb";
      thumb.dataset.index = String(index);
      if (item.postId) thumb.dataset.postId = item.postId;

      const video = document.createElement("video");
      video.crossOrigin = "use-credentials";
      video.setAttribute("crossorigin", "use-credentials");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.loop = true;
      video.autoplay = true;
      video.tabIndex = -1;
      if (item.poster) {
        video.poster = item.poster;
      }
      if (isPrivateUrl(item.url) && USE_BLOB_PROXY) {
        video.dataset.originalSrc = item.url;
        getBlobUrl(item.url)
          .then((blobUrl) => {
            if (video.dataset.originalSrc !== item.url) return;
            video.src = blobUrl;
            video.load();
            const playPromise = video.play();
            if (playPromise && typeof playPromise.catch === "function") {
              playPromise.catch(() => {});
            }
          })
          .catch(() => {});
      } else {
        video.src = item.url;
      }
      video.addEventListener(
        "loadeddata",
        () => {
          addLog(`Thumb loaded: ${item.url}`);
        },
        { once: true }
      );
      video.addEventListener("error", () => {
        const code = video.error ? video.error.code : "unknown";
        addLog(`Thumb error (${code}): ${item.url}`);
      });

      const overlay = document.createElement("div");
      overlay.className = "thumb-overlay";
      const statusChip = document.createElement("div");
      statusChip.className = "thumb-status";

      const actions = document.createElement("div");
      actions.className = "thumb-actions";

      const downloadAction = document.createElement("div");
      downloadAction.className = "icon-btn";
      downloadAction.title = "Download";
      downloadAction.textContent = "↓";
      downloadAction.setAttribute("role", "button");
      downloadAction.tabIndex = 0;
      downloadAction.addEventListener("click", (event) => {
        event.stopPropagation();
        downloadItem(item);
      });
      downloadAction.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          downloadItem(item);
        }
      });

      const deleteAction = document.createElement("div");
      deleteAction.className = "icon-btn danger";
      deleteAction.title = item.postId ? "Delete" : "Delete unavailable";
      deleteAction.textContent = "✕";
      deleteAction.disabled = !item.postId || state.busy;
      deleteAction.setAttribute("role", "button");
      deleteAction.tabIndex = item.postId ? 0 : -1;
      deleteAction.addEventListener("click", (event) => {
        event.stopPropagation();
        setThumbStatus(item.postId, "deleting", "Deleting...");
        deleteItem(item);
      });
      deleteAction.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!item.postId || state.busy) return;
          setThumbStatus(item.postId, "deleting", "Deleting...");
          deleteItem(item);
        }
      });

      actions.appendChild(downloadAction);
      actions.appendChild(deleteAction);
      overlay.appendChild(statusChip);
      overlay.appendChild(actions);

      thumb.appendChild(video);
      thumb.appendChild(overlay);
      thumb.addEventListener("click", () => openLightbox(index));
      card.appendChild(thumb);
      fragment.appendChild(card);
    });

    gridEl.appendChild(fragment);
    updateCount();
    updateActionButtons();
  };

  const loadPlayer = () => {
    if (!playerEl) return;
    const item = getSelected();
    if (!item) return;

    playerEl.pause();
    playerEl.loop = true;
    playerEl.crossOrigin = "use-credentials";
    playerEl.setAttribute("crossorigin", "use-credentials");
    if (isPrivateUrl(item.url) && USE_BLOB_PROXY) {
      playerEl.dataset.originalSrc = item.url;
      getBlobUrl(item.url)
        .then((blobUrl) => {
          if (playerEl.dataset.originalSrc !== item.url) return;
          playerEl.src = blobUrl;
          playerEl.load();
          const playPromise = playerEl.play();
          if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {});
          }
        })
        .catch(() => {});
    } else {
      playerEl.src = item.url;
      playerEl.load();
      const playPromise = playerEl.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    }
    playerEl.onloadeddata = () => {
      addLog(`Player loaded: ${item.url}`);
    };
    playerEl.onerror = () => {
      const code = playerEl.error ? playerEl.error.code : "unknown";
      addLog(`Player error (${code}): ${item.url}`);
    };
    updateCount();
    updateActionButtons();
  };

  const openLightbox = (index) => {
    if (!lightboxEl || !state.videos.length) return;
    state.selectedIndex = (index + state.videos.length) % state.videos.length;
    lightboxEl.classList.add("open");
    lightboxEl.setAttribute("aria-hidden", "false");
    loadPlayer();
  };

  const closeLightbox = () => {
    if (!lightboxEl) return;
    lightboxEl.classList.remove("open");
    lightboxEl.setAttribute("aria-hidden", "true");
    if (playerEl) playerEl.pause();
  };

  const step = (delta) => {
    if (!state.videos.length) return;
    state.selectedIndex = (state.selectedIndex + delta + state.videos.length) % state.videos.length;
    loadPlayer();
  };

  const updateVideos = (items, updatedAt = Date.now()) => {
    state.videos = normalizeItems(items);
    state.lastUpdatedAt = updatedAt || Date.now();
    const nextUrls = new Set(state.videos.map((item) => item.url));
    nextUrls.forEach((url) => {
      if (!state.knownUrls.has(url)) {
        addLog(`New video: ${url}`);
      }
    });
    state.knownUrls.forEach((url) => {
      if (!nextUrls.has(url)) {
        addLog(`Removed video: ${url}`);
      }
    });
    state.knownUrls = nextUrls;
    if (!state.videos.length) {
      setStatus("No videos yet. Keep favorites open.");
    } else {
      setStatus(`Loaded ${state.videos.length} MP4 video${state.videos.length === 1 ? "" : "s"}.`);
    }
    if (state.selectedIndex >= state.videos.length) {
      state.selectedIndex = 0;
    }
    renderGrid();
    if (lightboxEl && lightboxEl.classList.contains("open")) {
      loadPlayer();
    }
  };

  const loadFromStorage = () => {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      const payload = data && data[STORAGE_KEY] ? data[STORAGE_KEY] : null;
      const items = payload ? payload.items : [];
      updateVideos(items || [], payload ? payload.updatedAt : Date.now());
      addLog(`Storage loaded: ${items ? items.length : 0} videos`);
    });
  };

  const detectFavoritesTab = () => {
    chrome.tabs.query({ url: `${FAVORITES_URL}*` }, (tabs) => {
      const tab = tabs && tabs.length ? tabs[0] : null;
      state.favoritesTabId = tab ? tab.id : null;
      if (state.favoritesTabId) {
        setStatus("Favorites open. Live syncing...");
      } else if (!state.videos.length) {
        setStatus("Open Grok favorites to sync videos.");
      }
      updateActionButtons();
    });
  };

  const refreshFromFavorites = () => {
    setStatus("Refreshing favorites...");
    addLog("Refresh requested");
    sendToFavorites({ action: "grokViewerRefresh" }, (result) => {
      if (!result.ok) {
        setStatus("Refresh failed. Keep favorites open.");
        addLog(`Refresh failed: ${result.error || "unknown"}`);
        return;
      }
      addLog("Refresh completed");
      loadFromStorage();
    });
  };

  const startLogTimer = () => {};

  const stopLogTimer = () => {};

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

  const toggleLogs = () => {};

  const purgeCache = () => {
    if (!window.confirm("Purge cached list? This won't delete downloaded files.")) return;
    state.videos = [];
    clearBlobCache();
    updateVideos([], Date.now());
    addLog("Cache purged");
    sendToFavorites({ action: "grokViewerFullSync" }, (result) => {
      if (!result.ok) {
        setStatus("Refresh failed. Keep favorites open.");
        return;
      }
      setStatus("Full resync completed.");
    });
  };

  
  const initHideModToastToggle = () => {
    if (!hideModToastToggle) return;
    chrome.storage.local.get("gvHideModerationToast", (data) => {
      hideModToastToggle.checked = Boolean(data && data.gvHideModerationToast);
    });
  };

  const bindEvents = () => {
    if (refreshBtn) {
      refreshBtn.addEventListener("click", refreshFromFavorites);
    }

    if (githubBtn) {
      githubBtn.addEventListener("click", () => {
        const url = "https://github.com/exabeet/grok-viewer";
        if (chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url });
        } else {
          window.open(url, "_blank", "noopener");
        }
      });
    }

    if (purgeBtn) {
      purgeBtn.addEventListener("click", purgeCache);
    }

    if (hideModToastToggle) {
      hideModToastToggle.addEventListener("change", () => {
        const enabled = !!hideModToastToggle.checked;
        chrome.storage.local.set({ gvHideModerationToast: enabled });
        chrome.tabs.query({ url: "https://grok.com/*" }, (tabs) => {
          (tabs || []).forEach((tab) => {
            if (!tab || !tab.id) return;
            chrome.tabs.sendMessage(tab.id, { type: "GV_SET_HIDE_MOD_TOAST", enabled });
          });
        });
      });
    }

    if (downloadAllBtn) {
      downloadAllBtn.addEventListener("click", downloadAll);
    }

    if (deleteAllBtn) {
      deleteAllBtn.addEventListener("click", deleteAll);
    }

    if (downloadBtn) {
      downloadBtn.addEventListener("click", () => downloadItem(getSelected()));
    }

    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => deleteItem(getSelected()));
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", closeLightbox);
    }

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener("click", () => {
        if (!playerEl) return;
        const isFullscreen = document.fullscreenElement;
        if (isFullscreen) {
          document.exitFullscreen().catch(() => {});
          return;
        }
        if (playerEl.requestFullscreen) {
          playerEl.requestFullscreen().catch(() => {});
        }
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener("click", () => step(-1));
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => step(1));
    }

    if (lightboxEl) {
      lightboxEl.addEventListener("click", (event) => {
        if (event.target === lightboxEl) closeLightbox();
      });
    }

    document.addEventListener("fullscreenchange", () => {
      if (!fullscreenBtn) return;
      fullscreenBtn.textContent = document.fullscreenElement ? "Exit Fullscreen" : "Fullscreen";
    });

    document.addEventListener("keydown", (event) => {
      if (!lightboxEl || !lightboxEl.classList.contains("open")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "Escape") closeLightbox();
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
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

    chrome.storage.onChanged.addListener((changes) => {
      if (changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue) {
        const payload = changes[STORAGE_KEY].newValue;
        updateVideos(payload.items || [], payload.updatedAt);
        addLog(`Storage changed: ${payload.items ? payload.items.length : 0} videos`);
      }
    });

    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.action !== "grokViewerDeleteProgress") return;
        const current = message.index || 0;
        const total = message.total || 0;
        if (message.note === "delete-start") {
          addLog(`Delete started: ${message.postId}`);
          setStatus("Deleting...");
          return;
        }
        if (message.note === "delete-result") {
          addLog(`Delete result: ${message.postId} ${message.status}`);
          if (!message.ok) {
            setStatus("Delete failed. Keep favorites open.");
          }
          return;
        }
        if (total) {
          setStatus(`Deleting... ${current}/${total} videos deleted`);
        }
      });
    }
  };

  setMode();
  bindEvents();
  initHideModToastToggle();
  loadFromStorage();
  detectFavoritesTab();

  setInterval(detectFavoritesTab, 10000);
})();
