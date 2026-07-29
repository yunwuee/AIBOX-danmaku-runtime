export class FastifyFixture {
  constructor() {
    this.routes = new Map();
    this.log = {
      info() {},
      error() {},
    };
  }

  get(url, handler) {
    this.routes.set(`GET ${url}`, { method: 'GET', url, handler });
    return this;
  }

  hasRoute({ method, url }) {
    return this.routes.has(`${String(method).toUpperCase()} ${url}`);
  }

  printRoutes() {
    return [...this.routes.keys()].sort().join('\n');
  }

  async ready() {}

  async close() {}

  async inject({ method = 'GET', url }) {
    const requestUrl = new URL(url, 'http://127.0.0.1');
    const matched = this.#findRoute(String(method).toUpperCase(), requestUrl.pathname);
    if (!matched) return createResponse(404, { error: 'Not Found' }, {});

    let statusCode = 200;
    let sent = false;
    let payload;
    const headers = {};
    const reply = {
      code(value) {
        statusCode = Number(value);
        return reply;
      },
      header(name, value) {
        headers[String(name).toLowerCase()] = String(value);
        return reply;
      },
      send(value) {
        sent = true;
        payload = value;
        return value;
      },
    };
    const result = await matched.handler({
      raw: { url: `${requestUrl.pathname}${requestUrl.search}` },
      url: `${requestUrl.pathname}${requestUrl.search}`,
      params: matched.params,
      query: Object.fromEntries(requestUrl.searchParams),
    }, reply);
    if (!sent) payload = result;
    return createResponse(statusCode, payload, headers);
  }

  #findRoute(method, pathname) {
    for (const route of this.routes.values()) {
      if (route.method !== method) continue;
      const routeSegments = route.url.split('/').filter(Boolean);
      const pathSegments = pathname.split('/').filter(Boolean);
      if (routeSegments.length !== pathSegments.length) continue;
      const params = {};
      let matches = true;
      for (let index = 0; index < routeSegments.length; index += 1) {
        const routeSegment = routeSegments[index];
        const pathSegment = pathSegments[index];
        if (routeSegment.startsWith(':')) {
          params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
        } else if (routeSegment !== pathSegment) {
          matches = false;
          break;
        }
      }
      if (matches) return { ...route, params };
    }
    return null;
  }
}

function createResponse(statusCode, payload, headers) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  return {
    statusCode,
    body,
    headers,
    json() {
      return JSON.parse(body);
    },
  };
}
