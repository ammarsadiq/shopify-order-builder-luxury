export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Normalize trailing slash
    let path = url.pathname;

    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    try {
      // Health check
      if (request.method === "GET" && path === "/") {
        return json({
          success: true,
          message: "Shopify Order Builder API is running"
        });
      }

      // App Proxy health test
      if (
        request.method === "GET" &&
        path === "/proxy"
      ) {
        return json({
          success: true,
          message: "Shopify App Proxy is connected"
        });
      }

      // Create order
      if (
        request.method === "POST" &&
        path === "/proxy/create-order"
      ) {
        return await createOrder(request, env);
      }

      return json(
        {
          success: false,
          message: "Route not found",
          path: url.pathname
        },
        404
      );

    } catch (error) {
      console.error("Worker error:", error);

      return json(
        {
          success: false,
          message: error?.message || "Internal server error"
        },
        500
      );
    }
  }
};

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
