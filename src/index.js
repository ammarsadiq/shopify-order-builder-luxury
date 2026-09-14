const DISCOUNT_TIERS = [
  { min: 21, percentage: 10 },
  { min: 11, percentage: 8 },
  { min: 5, percentage: 5 }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // Health check
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          success: true,
          message: "Shopify Order Builder API is running"
        });
      }

      // Shopify App Proxy test route
      if (
        request.method === "GET" &&
        url.pathname === "/proxy"
      ) {
        return json({
          success: true,
          message: "Shopify App Proxy is connected"
        });
      }

      // Create order
      if (
        request.method === "POST" &&
        url.pathname === "/proxy/create-order"
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
          message:
            error?.message ||
            "Internal server error"
        },
        500
      );
    }
  }
};


/* =========================================================
   CREATE SHOPIFY ORDER
========================================================= */

async function createOrder(request, env) {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return json(
      {
        success: false,
        message: "Invalid JSON body"
      },
      400
    );
  }

  if (!payload?.customer?.email) {
    return json(
      {
        success: false,
        message: "Customer email is required"
      },
      422
    );
  }

  if (
    !Array.isArray(payload.items) ||
    payload.items.length === 0
  ) {
    return json(
      {
        success: false,
        message: "No products were submitted"
      },
      422
    );
  }


  /*
   * Get Shopify Admin API token
   */
  const accessToken =
    await getShopifyAccessToken(env);


  /*
   * Prepare variant IDs
   */
  const variantIds =
    payload.items.map(
      item =>
        `gid://shopify/ProductVariant/${item.variant_id}`
    );


  /*
   * Fetch real variant data from Shopify
   */
  const variantResult =
    await shopifyGraphQL(
      env,
      accessToken,
      `
        query GetVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              price

              product {
                title
              }
            }
          }

          shop {
            currencyCode
          }
        }
      `,
      {
        ids: variantIds
      }
    );


  if (variantResult.errors?.length) {
    console.error(
      "Variant GraphQL errors:",
      variantResult.errors
    );

    throw new Error(
      variantResult.errors
        .map(error => error.message)
        .join(", ")
    );
  }


  const variants =
    variantResult?.data?.nodes || [];

  const currencyCode =
    variantResult?.data?.shop?.currencyCode;


  const variantMap =
    new Map();


  for (const variant of variants) {
    if (!variant) continue;

    const numericId =
      variant.id.split("/").pop();

    variantMap.set(
      String(numericId),
      variant
    );
  }


  /*
   * Build Shopify line items
   */
  const lineItems = [];


  for (const item of payload.items) {
    const variant =
      variantMap.get(
        String(item.variant_id)
      );


    if (!variant) {
      return json(
        {
          success: false,
          message:
            `Variant ${item.variant_id} was not found`
        },
        422
      );
    }


    const quantity =
      normalizeQuantity(
        item.quantity
      );


    const discountPercentage =
      getDiscountPercentage(
        quantity
      );


    const lineItem = {
      variantId:
        variant.id,

      quantity
    };


    /*
     * Apply wholesale discount
     */
    if (discountPercentage > 0) {
      const unitPrice =
        Number(variant.price);


      const totalDiscount =
        unitPrice *
        quantity *
        (discountPercentage / 100);


      lineItem.totalDiscount = {
        value:
          totalDiscount.toFixed(2),

        currencyCode
      };
    }


    lineItems.push(
      lineItem
    );
  }


  /*
   * Customer info
   */
  const firstName =
    clean(
      payload.customer.first_name,
      100
    );


  const lastName =
    clean(
      payload.customer.last_name,
      100
    );


  const email =
    clean(
      payload.customer.email,
      320
    );


  const phone =
    clean(
      payload.customer.phone,
      50
    );


  const company =
    clean(
      payload.customer.company,
      200
    );


  const notes =
    clean(
      payload.note,
      3000
    );


  let finalNote =
    notes;


  if (company) {
    finalNote =
      `Company: ${company}` +
      (
        notes
          ? `\n\n${notes}`
          : ""
      );
  }


  /*
   * Create order
   */
  const result =
    await shopifyGraphQL(
      env,
      accessToken,
      `
        mutation CreateOrder(
          $order: OrderCreateOrderInput!,
          $options: OrderCreateOptionsInput
        ) {
          orderCreate(
            order: $order,
            options: $options
          ) {
            order {
              id
              name
              email
              createdAt
            }

            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        order: {
          email,

          phone:
            phone || undefined,

          note:
            finalNote || undefined,

          lineItems,

          customer: {
            toUpsert: {
              email,

              firstName:
                firstName || undefined,

              lastName:
                lastName || undefined
            }
          },

          customAttributes: [
            {
              key: "Order source",
              value: "Custom Order Builder"
            }
          ]
        },

        options: {
          sendReceipt: true
        }
      }
    );


  console.log(
    "ORDER CREATE RESPONSE:",
    JSON.stringify(result)
  );


  if (result.errors?.length) {
    return json(
      {
        success: false,
        message:
          result.errors
            .map(error => error.message)
            .join(", ")
      },
      422
    );
  }


  const orderCreate =
    result?.data?.orderCreate;


  if (
    orderCreate?.userErrors?.length
  ) {
    return json(
      {
        success: false,

        message:
          orderCreate.userErrors
            .map(
              error =>
                error.message
            )
            .join(", ")
      },
      422
    );
  }


  if (!orderCreate?.order) {
    return json(
      {
        success: false,
        message:
          "Shopify did not create the order"
      },
      500
    );
  }


  return json({
    success: true,

    message:
      "Order created successfully",

    orderId:
      orderCreate.order.id,

    orderName:
      orderCreate.order.name
  });
}


/* =========================================================
   SHOPIFY ACCESS TOKEN
========================================================= */

async function getShopifyAccessToken(env) {
  if (!env.SHOPIFY_SHOP) {
    throw new Error(
      "SHOPIFY_SHOP is missing"
    );
  }

  if (!env.SHOPIFY_CLIENT_ID) {
    throw new Error(
      "SHOPIFY_CLIENT_ID is missing"
    );
  }

  if (!env.SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      "SHOPIFY_CLIENT_SECRET is missing"
    );
  }


  const tokenUrl =
    `https://${env.SHOPIFY_SHOP}` +
    `/admin/oauth/access_token`;


  const body =
    new URLSearchParams({
      grant_type:
        "client_credentials",

      client_id:
        env.SHOPIFY_CLIENT_ID,

      client_secret:
        env.SHOPIFY_CLIENT_SECRET
    });


  const response =
    await fetch(
      tokenUrl,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body
      }
    );


  const data =
    await response.json();


  if (
    !response.ok ||
    !data.access_token
  ) {
    console.error(
      "TOKEN ERROR:",
      data
    );

    throw new Error(
      "Unable to get Shopify access token"
    );
  }


  return data.access_token;
}


/* =========================================================
   SHOPIFY GRAPHQL
========================================================= */

async function shopifyGraphQL(
  env,
  accessToken,
  query,
  variables = {}
) {
  const apiVersion =
    env.SHOPIFY_API_VERSION ||
    "2026-07";


  const endpoint =
    `https://${env.SHOPIFY_SHOP}` +
    `/admin/api/${apiVersion}/graphql.json`;


  const response =
    await fetch(
      endpoint,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          "X-Shopify-Access-Token":
            accessToken
        },

        body:
          JSON.stringify({
            query,
            variables
          })
      }
    );


  const text =
    await response.text();


  let data;


  try {
    data =
      JSON.parse(text);
  } catch {
    console.error(
      "NON JSON SHOPIFY RESPONSE:",
      text
    );

    throw new Error(
      `Shopify returned HTTP ${response.status}`
    );
  }


  if (!response.ok) {
    console.error(
      "SHOPIFY API ERROR:",
      data
    );

    throw new Error(
      `Shopify API returned HTTP ${response.status}`
    );
  }


  return data;
}


/* =========================================================
   WHOLESALE DISCOUNT
========================================================= */

function getDiscountPercentage(
  quantity
) {
  const qty =
    normalizeQuantity(
      quantity
    );


  for (
    const tier
    of DISCOUNT_TIERS
  ) {
    if (
      qty >= tier.min
    ) {
      return tier.percentage;
    }
  }


  return 0;
}


/* =========================================================
   HELPERS
========================================================= */

function normalizeQuantity(
  value
) {
  const quantity =
    parseInt(
      value,
      10
    );


  if (
    !Number.isFinite(quantity) ||
    quantity < 1
  ) {
    return 1;
  }


  return quantity;
}


function clean(
  value,
  maxLength = 255
) {
  return String(
    value || ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}


function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}
