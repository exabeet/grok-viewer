(() => {
  const SETTINGS_KEY = "grokViewerSettings";

  const sanitizeFolderPath = (value) => {
    if (!value) return "";
    return String(value)
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\.\./g, "")
      .replace(/[^a-zA-Z0-9/_-]/g, "")
      .replace(/\/+$/, "");
  };

  const openViewerWindow = (incognito) => {
    chrome.windows.create({
      url: "https://grok.com/imagine/favorites?grokViewer=1",
      type: "popup",
      width: 1200,
      height: 820,
      incognito: Boolean(incognito)
    });
  };

  const getDownloadSettingsUrls = () => {
    const ua = (navigator.userAgent || "").toLowerCase();
    const urls = [];
    if (ua.includes("opr") || ua.includes("opera")) urls.push("opera://settings/downloads");
    if (ua.includes("brave")) urls.push("brave://settings/downloads");
    urls.push("chrome://settings/downloads");
    return urls;
  };

  chrome.action.onClicked.addListener((tab) => {
    openViewerWindow(tab && tab.incognito);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.action === "openViewerWindow") {
      openViewerWindow(sender && sender.tab && sender.tab.incognito);
      sendResponse({ ok: true });
      return true;
    }

    if (message && message.action === "grokViewerDownloadUrl") {
      const url = message.postUrl || message.url;
      const requestedFilename = message.filename;
      const requestedSaveAs = message.saveAs === true;
      const requestedMode = message.mode;
      const requestedFolderPath = sanitizeFolderPath(message.folderPath || "");
      if (!url) {
        sendResponse({ ok: false, error: "no-url" });
        return true;
      }
      chrome.storage.local.get(SETTINGS_KEY, (data) => {
        const settings = data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : {};
        const storedMode = settings && settings.downloadMode ? settings.downloadMode : "ask_each";
        const mode =
          requestedMode === "folder_once" || requestedMode === "ask_each" || requestedMode === "default_auto"
            ? requestedMode
            : storedMode;
        const folderPath = requestedFolderPath || sanitizeFolderPath(settings && settings.folderPath ? settings.folderPath : "");
        let saveAs = requestedSaveAs;
        let filename = requestedFilename || "";
        if (mode === "folder_once") {
          saveAs = false;
          const cleanFilename = filename.replace(/^\/+/, "");
          if (cleanFilename && folderPath && !cleanFilename.startsWith(`${folderPath}/`) && !cleanFilename.includes("/")) {
            filename = `${folderPath}/${cleanFilename}`;
          }
        } else if (mode === "default_auto") {
          saveAs = false;
        }
        const options = { url, saveAs, conflictAction: "uniquify" };
        if (filename) options.filename = filename;
        chrome.downloads.download(options, (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ ok: true, downloadId });
        });
      });
      return true;
    }

    if (message && message.action === "grokViewerProxyToTab") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (!tabId) {
        sendResponse({ ok: false, error: "no-tab" });
        return true;
      }
      chrome.tabs.sendMessage(tabId, message.payload || {}, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, response });
      });
      return true;
    }

    if (message && message.action === "grokViewerDeleteViaMain") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const id = message.id;
      if (!tabId || !id) {
        sendResponse({ ok: false, error: "missing-tab-or-id" });
        return true;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: "MAIN",
          func: (postId) =>
            fetch("/rest/media/post/delete", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: postId })
            })
              .then(async (res) => {
                let bodyText = "";
                try {
                  bodyText = await res.text();
                } catch (e) {
                  bodyText = "";
                }
                return { ok: res.ok, status: res.status, body: bodyText };
              })
              .catch((err) => ({ ok: false, status: 0, body: String(err) })),
          args: [id]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          const payload = results && results[0] ? results[0].result : null;
          sendResponse(payload || { ok: false, status: 0, body: "" });
        }
      );
      return true;
    }

    if (message && message.action === "grokViewerSetHideModToast") {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (!tabId) {
        sendResponse({ ok: false, error: "no-tab" });
        return true;
      }
      chrome.tabs.sendMessage(tabId, { type: "GV_SET_HIDE_MOD_TOAST", enabled: !!message.enabled }, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, response });
      });
      return true;
    }

    if (message && message.action === "grokViewerOpenDownloads") {
      const filename = message.filename || "";
      const findDownload = (cb) => {
        if (!filename) {
          cb(null);
          return;
        }
        chrome.downloads.search({ query: [filename] }, (results) => {
          if (chrome.runtime.lastError || !results || !results.length) {
            cb(null);
            return;
          }
          const match =
            results.find((item) => item && item.filename && item.filename.endsWith(filename)) ||
            results.find((item) => item && item.filename && item.filename.includes(filename)) ||
            results[0];
          cb(match || null);
        });
      };
      const openDownloadsPage = () => {
        const ua = (navigator.userAgent || "").toLowerCase();
        const urls = [];
        if (ua.includes("opr") || ua.includes("opera")) urls.push("opera://downloads");
        if (ua.includes("brave")) urls.push("brave://downloads");
        urls.push("chrome://downloads");
        const tryOpen = (index) => {
          const url = urls[index];
          if (!url) {
            sendResponse({ ok: false, error: "no-downloads-url" });
            return;
          }
          chrome.tabs.create({ url }, () => {
            if (chrome.runtime.lastError) {
              tryOpen(index + 1);
              return;
            }
            sendResponse({ ok: true, method: "tab", url });
          });
        };
        tryOpen(0);
      };
      if (chrome.downloads && chrome.downloads.show) {
        findDownload((match) => {
          if (match && match.id) {
            try {
              chrome.downloads.show(match.id);
              sendResponse({ ok: true, method: "show", id: match.id });
            } catch (e) {
              openDownloadsPage();
            }
            return;
          }
          if (chrome.downloads && chrome.downloads.showDefaultFolder) {
            try {
              chrome.downloads.showDefaultFolder();
              sendResponse({ ok: true, method: "folder" });
              return;
            } catch (e) {}
          }
          openDownloadsPage();
        });
        return true;
      }
      openDownloadsPage();
      return true;
    }

    if (message && message.action === "grokViewerOpenDownloadSettingsAndReopen") {
      const urls = getDownloadSettingsUrls();
      const openAt = (index) => {
        const url = urls[index];
        if (!url) {
          sendResponse({ ok: false, error: "settings-url-unavailable" });
          return;
        }
        chrome.tabs.create({ url, active: true }, (tab) => {
          if (!chrome.runtime.lastError && tab && tab.id) {
            sendResponse({ ok: true, url, method: "tab" });
            return;
          }
          chrome.windows.create({ url, type: "normal", focused: true }, (win) => {
            if (chrome.runtime.lastError || !win || !win.id) {
              openAt(index + 1);
              return;
            }
            sendResponse({ ok: true, url, method: "window" });
          });
        });
      };
      openAt(0);
      return true;
    }

    if (message && message.action === "grokViewerWaitForDownload") {
      const filename = message.filename || "";
      const requireComplete = !!message.requireComplete;
      const timeoutMs = 15 * 60 * 1000;
      const start = Date.now();
      const poll = () => {
        if (!filename) {
          sendResponse({ ok: false, error: "no-filename" });
          return;
        }
        chrome.downloads.search({ query: [filename] }, (results) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          const match =
            (results || []).find((item) => item && item.filename && item.filename.endsWith(filename)) ||
            (results || []).find((item) => item && item.filename && item.filename.includes(filename));
          if (match && (!requireComplete || match.state === "complete")) {
            sendResponse({ ok: true, id: match.id, state: match.state });
            return;
          }
          if (Date.now() - start > timeoutMs) {
            sendResponse({ ok: false, error: "timeout" });
            return;
          }
          setTimeout(poll, 700);
        });
      };
      poll();
      return true;
    }

    if (message && message.action === "grokViewerGetDownloadById") {
      const downloadId = Number(message.downloadId || 0);
      if (!downloadId) {
        sendResponse({ ok: false, error: "no-download-id" });
        return true;
      }
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const item = results && results.length ? results[0] : null;
        if (!item) {
          sendResponse({ ok: false, error: "not-found" });
          return;
        }
        sendResponse({
          ok: true,
          id: item.id,
          state: item.state || "",
          error: item.error || "",
          filename: item.filename || ""
        });
      });
      return true;
    }

    return false;
  });
})();
