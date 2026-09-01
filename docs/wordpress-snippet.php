<?php
/**
 * WordPress → Payload middleware integration.
 *
 * Your custom form already assembles the submission and sends emails. Add a
 * call to inquiry_send_to_payload($data, $image_urls) at that point (in place
 * of, or alongside, the email). It builds the exact JSON contract the Payload
 * `/api/webhooks/wordpress-inquiry` endpoint expects, signs the raw body with
 * HMAC-SHA256, and POSTs it.
 *
 * Set these in wp-config.php (must match the Payload server's env):
 *   define('PAYLOAD_URL', 'https://middleware.your-domain.com');
 *   define('PAYLOAD_WEBHOOK_SECRET', 'the-same-long-random-secret-as-WEBHOOK_SECRET');
 */

if (!function_exists('inquiry_send_to_payload')) {
    /**
     * @param array $data       The inquiry, matching the Payload contract (see below).
     * @param array $image_urls Absolute URLs of uploaded reference images in the WP media library.
     * @return bool             True on 2xx from Payload.
     */
    function inquiry_send_to_payload(array $data, array $image_urls = []): bool
    {
        $endpoint = rtrim(PAYLOAD_URL, '/') . '/api/webhooks/wordpress-inquiry';
        $secret   = PAYLOAD_WEBHOOK_SECRET;

        // Build the contract. Keep this shape in sync with the zod schema in
        // src/endpoints/intake.ts.
        $payload = [
            'customer' => [
                'name'  => $data['customer_name']  ?? '',
                'email' => $data['customer_email'] ?? '',
                'phone' => $data['customer_phone'] ?? '',
            ],
            'deceased' => [
                'name'     => $data['deceased_name'] ?? '',
                'bornDate' => $data['deceased_born'] ?? '',
                'diedDate' => $data['deceased_died'] ?? '',
            ],
            // The DK ItemCode (vörunúmer) the customer chose:
            'product' => [
                'itemCode' => $data['product_item_code'] ?? '',
            ],
            // One string per inscription line:
            'inscriptionLines' => array_values(array_filter($data['inscription_lines'] ?? [])),
            // Material / add-on codes:
            'addons' => array_map(function ($a) {
                return [
                    'code'  => $a['code'] ?? '',
                    'label' => $a['label'] ?? '',
                    'qty'   => (int) ($a['qty'] ?? 1),
                ];
            }, $data['addons'] ?? []),
            // Absolute URLs of reference images already in the WP media library:
            'referenceImageUrls' => array_values($image_urls),
        ];

        // IMPORTANT: sign the EXACT bytes we send. Encode once, sign that string.
        $body = wp_json_encode($payload);
        $signature = hash_hmac('sha256', $body, $secret);

        $response = wp_remote_post($endpoint, [
            'method'  => 'POST',
            'timeout' => 15,
            'headers' => [
                'Content-Type' => 'application/json',
                'X-Signature'  => $signature,
                // Optional simpler fallback the endpoint also accepts:
                // 'X-Webhook-Secret' => $secret,
            ],
            'body' => $body,
        ]);

        if (is_wp_error($response)) {
            error_log('[inquiry->payload] transport error: ' . $response->get_error_message());
            return false;
        }

        $code = wp_remote_retrieve_response_code($response);
        if ($code < 200 || $code >= 300) {
            error_log('[inquiry->payload] HTTP ' . $code . ' — ' . wp_remote_retrieve_body($response));
            return false;
        }

        return true;
    }
}

/*
 * ---------------------------------------------------------------------------
 * EXAMPLE — call it from your form handler. Replace the array keys on the left
 * ($data[...]) with your form's actual field values.
 * ---------------------------------------------------------------------------
 *
 * inquiry_send_to_payload([
 *     'customer_name'     => $form['name'],
 *     'customer_email'    => $form['email'],
 *     'customer_phone'    => $form['phone'],
 *     'deceased_name'     => $form['deceased_name'],
 *     'deceased_born'     => $form['born'],
 *     'deceased_died'     => $form['died'],
 *     'product_item_code' => $form['product_id'],   // must be the DK ItemCode
 *     'inscription_lines' => $form['inscriptions'], // array of strings
 *     'addons'            => [                       // array of {code,label,qty}
 *         ['code' => 'ADDON-GOLD', 'label' => 'Gold leaf', 'qty' => 1],
 *     ],
 * ], [
 *     // absolute media-library URLs of the uploaded reference images:
 *     'https://your-wordpress-site.com/wp-content/uploads/2026/07/ref1.jpg',
 * ]);
 */
