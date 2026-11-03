const http = require("node:http");
const https = require("node:https");

const MAX_RESPONSE_BYTES = 1024 * 1024;

function requestProbe(targetUrl, timeoutMs, statusOnly = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Unsupported probe URL");
    }
    const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 30000) : 5000;
    let req;
    let response;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        response?.destroy();
        req?.destroy();
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new Error("Probe deadline exceeded")), deadlineMs);
    try {
      req = (url.protocol === "https:" ? https : http).get(url, {
        headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      }, res => {
        response = res;
        res.on("error", () => finish(new Error("Probe response failed")));
        res.on("aborted", () => finish(new Error("Probe response aborted")));
        res.on("close", () => {
          if (!res.complete) finish(new Error("Probe response closed early"));
        });
        if (statusOnly) {
          finish(null, { statusCode: res.statusCode });
          res.destroy();
          return;
        }
        if (Number(res.headers["content-length"]) > MAX_RESPONSE_BYTES) {
          finish(new Error("Probe response exceeds size limit"));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new Error("Probe response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          try {
            finish(null, { statusCode: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            finish(new Error("Probe response is not valid JSON"));
          }
        });
      });
      req.on("error", () => finish(new Error("Probe connection failed")));
    } catch {
      finish(new Error("Probe request failed"));
    }
  });
}

module.exports = {
  MAX_RESPONSE_BYTES,
  httpJsonGet: (url, timeoutMs) => requestProbe(url, timeoutMs),
  httpStatusGet: (url, timeoutMs) => requestProbe(url, timeoutMs, true),
};
