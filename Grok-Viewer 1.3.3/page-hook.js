(() => {
  if (window.__grokViewerHooked) return;
  window.__grokViewerHooked = true;

  const post = (url) => {
    if (!url) return;
    window.postMessage({ source: "grok-viewer", type: "videoUrl", url, pageUrl: window.location.href }, "*");
  };

  const parseLine = (line) => {
    if (!line) return;
    if (line.indexOf("streamingVideoGenerationResponse") === -1) return;
    try {
      const obj = JSON.parse(line);
      const resp =
        obj &&
        obj.result &&
        obj.result.response &&
        obj.result.response.streamingVideoGenerationResponse;
      if (resp && resp.videoUrl) {
        post(resp.videoUrl);
      }
    } catch (error) {
      // ignore parse errors
    }
  };

  const parseText = (text) => {
    if (!text) return;
    const lines = text.split(/\n+/);
    for (let i = 0; i < lines.length; i += 1) {
      parseLine(lines[i]);
    }
  };

  const parseStream = (stream) => {
    if (!stream || !stream.getReader) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = () => {
      reader
        .read()
        .then((result) => {
          if (result.value) {
            buffer += decoder.decode(result.value, { stream: !result.done });
            const parts = buffer.split(/\n+/);
            buffer = parts.pop() || "";
            for (let i = 0; i < parts.length; i += 1) {
              parseLine(parts[i]);
            }
          }
          if (!result.done) {
            pump();
          } else if (buffer) {
            parseLine(buffer);
          }
        })
        .catch(() => {});
    };

    pump();
  };

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function fetchWrapper() {
      return originalFetch.apply(this, arguments).then((response) => {
        try {
          const url = response.url || "";
          if (url.indexOf("/rest/app-chat/conversations/new") !== -1) {
            const clone = response.clone();
            if (clone.body && clone.body.getReader) {
              parseStream(clone.body);
            } else {
              clone.text().then(parseText).catch(() => {});
            }
          }
        } catch (error) {
          // ignore
        }
        return response;
      });
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && OriginalXHR.prototype) {
    const originalOpen = OriginalXHR.prototype.open;
    OriginalXHR.prototype.open = function openWrapper(method, url) {
      this.__grokViewerUrl = url;
      return originalOpen.apply(this, arguments);
    };
    const originalSend = OriginalXHR.prototype.send;
    OriginalXHR.prototype.send = function sendWrapper() {
      this.addEventListener("load", () => {
        try {
          if (
            this.__grokViewerUrl &&
            this.__grokViewerUrl.indexOf("/rest/app-chat/conversations/new") !== -1
          ) {
            parseText(this.responseText || "");
          }
        } catch (error) {
          // ignore
        }
      });
      return originalSend.apply(this, arguments);
    };
  }
})();
