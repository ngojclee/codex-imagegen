function toHeaderObject(headers = {}) {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

export function buildManagementRequestInit(options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const { headers, ...rest } = options;

  return {
    ...rest,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(method === "GET" ? {} : { "x-codex-imagegen-csrf": "1" }),
      ...toHeaderObject(headers),
    },
  };
}
