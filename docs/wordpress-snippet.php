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
                'firstName' => $data['customer_first_name'] ?? '',
                'lastName'  => $data['customer_last_name']  ?? '',
                'kennitala' => $data['customer_kennitala']  ?? '',
                'address'   => $data['customer_address']    ?? '',
                'phone'     => $data['customer_phone']      ?? '',
                'email'     => $data['customer_email']      ?? '',
            ],
            'deceased' => [
                'firstName' => $data['deceased_first_name'] ?? '',
                'lastName'  => $data['deceased_last_name']  ?? '',
                'bornDate'  => $data['deceased_born'] ?? '', // yyyy-mm-dd or dd.mm.yy
                'diedDate'  => $data['deceased_died'] ?? '',
            ],
            // The tombstone (Steinn) — DK ItemCode / vörunúmer, e.g. "H111":
            'product' => [
                'itemCode' => $data['product_item_code'] ?? '',
            ],
            // Extra inscription lines. The deceased name and the "f.… d.…"
            // dates line are generated automatically — do NOT repeat them here:
            'inscriptionLines' => array_values(array_filter($data['inscription_lines'] ?? [])),
            // Template selects (Icelandic values from the template option lists):
            'options' => array_filter([
                'letur'          => $data['letur']       ?? null, // font
                'litur'          => $data['litur']       ?? null, // lettering colour
                'stoneColor'     => $data['stone_color'] ?? null, // Glitir code (SB, BG, …)
                'cemetery'       => $data['cemetery']    ?? null, // Kirkjugarður
                'delivery'       => $data['delivery']    ?? null, // Afhending
                'perCharPrice'   => isset($data['per_char_price']) ? (int) $data['per_char_price'] : null,
                'solumadur'      => $data['solumadur']   ?? null,
                'comments'       => $data['comments']    ?? null, // Athugasemdir
                'blomarammiVerd' => isset($data['blomarammi_verd']) ? (int) $data['blomarammi_verd'] : null,
                'uppsetningVerd' => isset($data['uppsetning_verd']) ? (int) $data['uppsetning_verd'] : null,
            ], fn ($v) => $v !== null && $v !== ''),
            // Typed add-ons — type decides the template section:
            // kross | luktVasi | fugl | mynd | rammi | annad
            'addons' => array_map(function ($a) {
                return [
                    'type'  => $a['type']  ?? 'annad',
                    'code'  => $a['code']  ?? '',
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
 *     'customer_first_name' => $form['first_name'],
 *     'customer_last_name'  => $form['last_name'],
 *     'customer_kennitala'  => $form['kennitala'],
 *     'customer_address'    => $form['address'],
 *     'customer_phone'      => $form['phone'],
 *     'customer_email'      => $form['email'],
 *     'deceased_first_name' => $form['deceased_first_name'],
 *     'deceased_last_name'  => $form['deceased_last_name'],
 *     'deceased_born'       => $form['born'],            // '1951-04-17' or '17.04.51'
 *     'deceased_died'       => $form['died'],
 *     'product_item_code'   => $form['stone_code'],      // DK ItemCode, e.g. 'H111'
 *     'inscription_lines'   => $form['inscriptions'],    // extra lines only
 *     'letur'               => $form['font'],            // e.g. 'Times New Roman'
 *     'litur'               => $form['letter_color'],    // e.g. 'Gull'
 *     'stone_color'         => $form['stone_color'],     // e.g. 'SB'
 *     'cemetery'            => $form['cemetery'],        // e.g. 'Gufunes'
 *     'per_char_price'      => 260,                      // 260 | 1070 | 1250 | 1490
 *     'addons'              => [                          // {type,code,label,qty}
 *         ['type' => 'kross',    'code' => 'BK101', 'label' => 'Kross',  'qty' => 1],
 *         ['type' => 'luktVasi', 'code' => 'LK01',  'label' => 'Lukt',   'qty' => 1],
 *         ['type' => 'fugl',     'code' => 'FK01',  'label' => 'Dúfa',   'qty' => 2],
 *     ],
 * ], [
 *     // absolute media-library URLs of the uploaded reference images:
 *     'https://your-wordpress-site.com/wp-content/uploads/2026/07/ref1.jpg',
 * ]);
 */
