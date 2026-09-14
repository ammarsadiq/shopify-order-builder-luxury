
export default {
  async fetch(request, env) {
    return new Response(
      JSON.stringify({
        success: true,
        message: "Shopify Order Builder API is running"
      }),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
};
