import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

describe('connector catalog', () => {
  it('ships complete ten-locale copy for every built-in card and setup surface', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const missingCopy = (items: unknown[]) => {
      const missing: string[] = [];
      const visit = (node: any, location: string) => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (/^(description|label|help|instructions|callback_help|guide_label)_en$/.test(key) && value) {
            for (const lang of ['zh', 'ja', 'pt', 'es', 'fr', 'ko', 'de', 'ru', 'it']) {
              const sibling = key.replace(/_en$/, `_${lang}`);
              if (typeof node[sibling] !== 'string' || !node[sibling].trim()) missing.push(`${location}.${sibling}`);
            }
          }
          if (value && typeof value === 'object') visit(value, `${location}.${key}`);
        }
      };
      items.forEach((item: any) => visit(item, item.id));
      return missing;
    };
    expect(CONNECTOR_CATALOG.length).toBeGreaterThan(100);
    expect(missingCopy(CONNECTOR_CATALOG)).toEqual([]);
    // Negative control: a single omitted form label must be detected, even if English exists.
    const broken = [{ id: 'canary', connection_setup: { fields: [{ label_en: 'Shop ID', label_zh: '店铺 ID', label_pt: 'ID da loja', label_es: 'ID de la tienda', label_fr: 'ID de la boutique', label_ko: '상점 ID', label_de: 'Shop-ID', label_ru: 'ID магазина', label_it: 'ID del negozio' }] } }];
    expect(missingCopy(broken)).toEqual(['canary.connection_setup.fields.0.label_ja']);
  });

  it('provides renderer-only catalog descriptions for every supported UI locale', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const { SUPPORTED_LANGS } = await import('../../../../src/main/i18n');
    for (const language of SUPPORTED_LANGS) {
      const table = JSON.parse(readFileSync(new URL(`../../../../src/renderer/locales/${language}.json`, import.meta.url), 'utf8'));
      for (const entry of CONNECTOR_CATALOG) {
        const key = `connectors.catalog.${entry.id}.description`;
        expect(typeof table[key], `${language}/${key}`).toBe('string');
        expect(table[key].trim(), `${language}/${key}`).not.toBe('');
        if (language === 'en') expect(table[key], key).toBe(entry.description_en);
      }
    }
  });

  it('provides a localized HTTPS guide for every built-in connector that requires setup fields', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const setupEntries = CONNECTOR_CATALOG.filter((entry) => entry.connection_setup?.fields?.length);
    expect(setupEntries.length).toBeGreaterThan(0);
    expect(setupEntries.flatMap((entry) => {
      const setup = entry.connection_setup;
      if (!setup?.guide_url?.match(/^https:\/\//)) return [`${entry.id}.guide_url`];
      return ['zh', 'en', 'ja', 'pt', 'es', 'fr', 'ko', 'de', 'ru', 'it']
        .filter((lang) => !String(setup[`guide_label_${lang}` as keyof typeof setup] || '').trim())
        .map((lang) => `${entry.id}.guide_label_${lang}`);
    })).toEqual([]);
  });

  it('offers only production for new commerce connections', async () => {
    const { connectorCatalog, findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    for (const entry of connectorCatalog()) {
      for (const field of entry.connection_setup?.fields || []) {
        expect(field.options?.map(option => option.value) || [], entry.id).not.toContain('sandbox');
      }
      expect(entry.connection_variants?.map(variant => variant.catalog_id) || [], entry.id)
        .not.toContain('paypal-sandbox');
    }
    for (const id of ['shopee', 'square', 'instacart-shopping', 'reloadly', 'walmart-marketplace', 'ebay-seller', 'amazon-seller-central']) {
      expect(findCatalogEntry(id)?.connection_setup?.fields.map(field => field.key), id)
        .not.toContain('environment');
    }
  });
  it('keeps every spawned local adapter in the packaged entrypoint contract', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const { CONNECTOR_CATALOG_ENTRYPOINTS } = require('../../../../bin/packaged-entrypoint-gate.cjs') as {
      CONNECTOR_CATALOG_ENTRYPOINTS: readonly string[];
    };
    const actual = catalog.connectorCatalog()
      .flatMap((entry) => entry.transport_template?.kind === 'stdio'
        ? entry.transport_template.args || []
        : [])
      .map((arg) => String(arg).match(/\/bin\/([A-Za-z0-9._-]+\.cjs)$/)?.[1] || '')
      .filter(Boolean)
      .sort();

    expect(CONNECTOR_CATALOG_ENTRYPOINTS).toEqual(expect.arrayContaining([...new Set(actual)]));
  });

  it('includes the official-CLI domestic collaboration batch with governed tools and real artwork provenance', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const domestic = await import('../../../../src/main/features/connectors/catalog-domestic');
    const runtime = await import('../../../../src/main/features/connectors/local-cli');
    const expected = [
      ['wecom', 'wecom', undefined, '@wecom/cli', '1.2.0', 'https://api.iconify.design/tdesign/logo-wecom.svg', '8aa5f73c8b17c0229ffe431bee8dfc327ccad1333352cd99159dc7add1249f13', '30870884eb42e179c6c7ab992690b5455e420b754f4d9d7b04cb609f25c47a69'],
      ['feishu', 'lark', 'feishu', '@larksuite/cli', '1.0.93', 'https://framerusercontent.com/images/yjUmyrg0qV5d2Glkjn9sDqzacY.svg', '8685f45f473cf24b93dc74b4de60ca62ff4500b098c61ceb9915a05f86c8d6f4', '90652b2b052c89dacdc7aed033f17da193db943d3d2e09c246d6036490ef40d6'],
      ['lark', 'lark', 'lark', '@larksuite/cli', '1.0.93', 'https://framerusercontent.com/images/yjUmyrg0qV5d2Glkjn9sDqzacY.svg', '8685f45f473cf24b93dc74b4de60ca62ff4500b098c61ceb9915a05f86c8d6f4', '90652b2b052c89dacdc7aed033f17da193db943d3d2e09c246d6036490ef40d6'],
      ['dingtalk', 'dingtalk', undefined, 'dingtalk-workspace-cli', '1.0.61', 'https://api.iconify.design/ant-design/dingtalk.svg', '5d9022d5b091b35a818e62fafdfcdb86955f339940308f33d470d99d18956a84', '8ee000fa0f9fa9094dad5a282ee5672feb4940dae2e3bd5c92a7f9055579bf17'],
    ] as const;

    for (const [id, provider, brand, packageName, packageVersion, iconSourceUrl, iconSourceSha256, iconHash] of expected) {
      const entry = catalog.findCatalogEntry(id);
      expect(entry).toMatchObject({
        id,
        category: 'communication',
        auth_mode: 'local_cli',
        local_cli: {
          provider,
          package_name: packageName,
          package_version: packageVersion,
          ...(brand ? { brand } : {}),
        },
        transport_template: {
          kind: 'stdio',
          args: ['${ORKAS_PC_DIR}/bin/local-cli-mcp-server.cjs'],
        },
      });
      expect(entry?.local_cli?.package_integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(entry?.local_cli?.allowed_domains.length).toBeGreaterThanOrEqual(13);
      expect(entry?.allowed_tools).toEqual([...domestic.LOCAL_CLI_TOOLS]);
      expect(Object.keys(entry?.tool_policies || {}).sort()).toEqual([...domestic.LOCAL_CLI_TOOLS].sort());
      expect(entry?.tool_policies).toMatchObject({
        execute_read: { risk: 'R', confirmation: 'none' },
        execute_write: { risk: 'W', confirmation: 'preview' },
        execute_high_impact: { risk: 'H', confirmation: 'fresh' },
        execute_destructive: { risk: 'D', confirmation: 'destructive' },
      });
      expect(entry?.icon_svg).toContain('<path');
      expect(entry?.icon_svg).not.toContain('<image');
      expect(entry?.icon_source_url).toBe(iconSourceUrl);
      expect(entry?.icon_source_sha256).toBe(iconSourceSha256);
      expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(iconHash);
      expect(entry?.local_cli).toMatchObject(runtime.LOCAL_CLI_MANIFESTS[provider]);
    }

    expect(catalog.findCatalogEntry('feishu')?.connection_variants).toBeUndefined();
    expect(catalog.findCatalogEntry('lark')?.catalog_parent_id).toBe('feishu');
    expect(catalog.findCatalogEntry('wecom')).toMatchObject({
      display_name_zh: '企业微信',
      display_name_en: 'WeCom',
    });
    expect(catalog.findCatalogEntry('feishu')).toMatchObject({
      display_name_zh: '飞书',
      display_name_en: 'Lark',
      local_cli: { provider: 'lark', brand: 'feishu' },
    });
    expect(catalog.findCatalogEntry('dingtalk')).toMatchObject({
      display_name_zh: '钉钉',
      display_name_en: 'DingTalk',
    });
  });

  it('includes Xero through its official PKCE CLI with full governed accounting coverage', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const domestic = await import('../../../../src/main/features/connectors/catalog-domestic');
    const runtime = await import('../../../../src/main/features/connectors/local-cli');
    const entry = catalog.findCatalogEntry('xero');

    expect(entry).toMatchObject({
      id: 'xero',
      display_name: 'Xero',
      category: 'commerce',
      auth_mode: 'local_cli',
      icon_source_url: 'https://api.iconify.design/logos/xero.svg',
      icon_source_sha256: '6850f5259ff70c8d5760c9d30f7e66ba07ad4d79b85be769e53f934fc5d5ebda',
      local_cli: {
        provider: 'xero',
        package_name: '@xeroapi/xero-command-line',
        package_version: '0.0.7',
        executable: 'xero',
      },
      transport_template: {
        kind: 'stdio',
        args: ['${ORKAS_PC_DIR}/bin/local-cli-mcp-server.cjs'],
      },
    });
    expect(entry?.icon_svg).toContain('fill="#1fc0e7"');
    expect(entry?.icon_svg).not.toContain('<image');
    expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(
      'e9f28c11b33b516824cf535f3153d9c42276224fe189481a38cd8f3b12a0b993',
    );
    expect(entry?.allowed_tools).toEqual([...domestic.LOCAL_CLI_TOOLS]);
    expect(entry?.local_cli).toMatchObject(runtime.LOCAL_CLI_MANIFESTS.xero);
    expect(entry?.local_cli?.allowed_domains).toEqual(expect.arrayContaining([
      'contacts', 'invoices', 'payments', 'bank-transactions', 'reports',
    ]));
  });

  it('keeps every newly reviewed connector icon traceable and rejects accidental brand reuse', async () => {
    const commerce = await import('../../../../src/main/features/connectors/catalog-commerce');
    const direct = await import('../../../../src/main/features/connectors/catalog-direct-commerce');
    const domestic = await import('../../../../src/main/features/connectors/catalog-domestic');
    const localCommerce = await import('../../../../src/main/features/connectors/catalog-local-commerce');
    const remote = await import('../../../../src/main/features/connectors/catalog-remote-commerce');
    const japan = await import('../../../../src/main/features/connectors/catalog-japan-commerce');
    const auditedEntries = [
      ...commerce.COMPOSIO_COMMERCE_ENTRIES,
      ...direct.DIRECT_COMMERCE_ENTRIES,
      ...domestic.DOMESTIC_COLLABORATION_ENTRIES,
      ...localCommerce.LOCAL_COMMERCE_ENTRIES,
      ...remote.REMOTE_COMMERCE_ENTRIES,
      ...japan.JAPAN_COMMERCE_ENTRIES,
    ];

    expect(auditedEntries).toHaveLength(102);
    expect(auditedEntries.map((entry) => entry.id)).toEqual(expect.arrayContaining(['shopee', 'tiktok-shop']));
    const idsByIconHash = new Map<string, string[]>();
    for (const entry of auditedEntries) {
      expect(entry.icon_source_url, entry.id).toMatch(/^https:\/\//);
      expect(entry.icon_source_sha256, entry.id).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.icon_svg, entry.id).toMatch(/^<svg(?:\s|>)/i);
      expect(entry.icon_svg, entry.id).toContain('width="100%"');
      expect(entry.icon_svg, entry.id).toContain('height="100%"');
      expect(entry.icon_svg, entry.id).not.toMatch(/<(?:script|foreignObject|iframe|image|use)\b/i);
      const iconHash = createHash('sha256').update(entry.icon_svg || '').digest('hex');
      idsByIconHash.set(iconHash, [...(idsByIconHash.get(iconHash) || []), entry.id]);
    }

    const duplicateBrandGroups = [...idsByIconHash.values()]
      .filter((ids) => ids.length > 1)
      .map((ids) => ids.sort())
      .sort(([left], [right]) => left.localeCompare(right));
    expect(duplicateBrandGroups).toEqual([
      ['feishu', 'lark'],
      ['paypal', 'paypal-sandbox'],
    ]);
  });

  it('renders every connector icon as visible ink at the card size', async () => {
    const { CONNECTOR_CATALOG } = await import('../../../../src/main/features/connectors/catalog');
    const visibleInkPixels = async (svg: string) => {
      const pixels = await sharp(Buffer.from(svg))
        .resize(20, 20, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .flatten({ background: '#fff' })
        .removeAlpha()
        .raw()
        .toBuffer();
      let visible = 0;
      for (let offset = 0; offset < pixels.length; offset += 3) {
        if (Math.max(255 - pixels[offset], 255 - pixels[offset + 1], 255 - pixels[offset + 2]) > 24) visible += 1;
      }
      return visible;
    };

    const emptyClip = '<svg viewBox="0 0 20 20"><defs><clipPath id="empty"><rect /></clipPath></defs><g clip-path="url(#empty)"><rect width="20" height="20" fill="black" /></g></svg>';
    expect(await visibleInkPixels(emptyClip)).toBe(0);
    for (const entry of CONNECTOR_CATALOG) {
      expect(entry.icon_svg, entry.id).toBeTruthy();
      expect(await visibleInkPixels(entry.icon_svg!), entry.id).toBeGreaterThan(0);
    }
  });

  it('publishes seller-owned marketplace apps with pinned official icons and only implemented risk lanes', async () => {
    const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
    const expected = [
      ['shopee', 'shopee', 'https://open.shopee.com/favicon.ico', '8c8d19147f7b2ff2adc16e2198c1fb32d81eacf704c495eecb1ebbbc6c9ead79', 'b5405215bb8f4b34b8e0a8cb2d720be384520e97a42746a13087ce15a29488a9', ['partner_id', 'partner_key']],
      ['tiktok-shop', 'tiktok_shop', 'https://lf16-cdn-tos.tiktokcdn-us.com/obj/static-tx/i18n/ecom/TTS/normal/tts.ico', '32d05bd2db26d8b0155a349bd0fffc3419c89a4a59459b11b3d316ebfb3bc8ea', '6c50ace0f61a32afc48197bb505cff4ca98122e59c84aafff5eee09d0ae7f541', ['service_id', 'app_key', 'app_secret']],
    ] as const;
    const tools = ['list_capabilities', 'describe_action', 'execute_read', 'execute_high_impact'];
    for (const [id, provider, source, sourceHash, svgHash, credentials] of expected) {
      const entry = findCatalogEntry(id)!;
      expect(entry).toMatchObject({ auth_mode: 'local_api', category: 'commerce',
        local_api: { provider }, connection_setup: { requirement: 'provider_application' },
        icon_source_url: source, icon_source_sha256: sourceHash, allowed_tools: tools });
      expect(createHash('sha256').update(entry.icon_svg!).digest('hex')).toBe(svgHash);
      expect(Object.keys(entry.tool_policies!).sort()).toEqual([...tools].sort());
      expect(entry.tool_policies!.execute_high_impact).toMatchObject({ risk: 'H', confirmation: 'fresh' });
      expect(entry.connection_setup!.fields).toHaveLength(id === 'shopee' ? 4 : 5);
      expect(entry.connection_setup!.fields.filter((field) => field.storage === 'credential').map((field) => field.key))
        .toEqual(credentials);
      expect(entry.connection_setup!.callback_url).toBe('https://orkas.ai/api/connectors/oauth/dcr-callback');
      for (const instructions of [entry.connection_setup!.instructions_en, entry.connection_setup!.instructions_zh]) {
        expect(instructions).not.toContain(entry.connection_setup!.callback_url);
      }
      if (id === 'shopee') expect(entry.connection_setup!.fields.map(field => field.key))
        .toEqual(['region', 'shop_id', 'partner_id', 'partner_key']);
      expect(entry.connection_setup!.fields.map((field) => field.key)).not.toContain('shop_cipher');
    }
  });

  it('includes the direct commerce BYOA/BYOK batch with real artwork and device-only credential fields', async () => {
    const catalog = await import('../../../../src/main/features/connectors/catalog');
    const direct = await import('../../../../src/main/features/connectors/catalog-direct-commerce');
    const expected = [
      ['commerce-layer', 'Commerce Layer', 'commerce_layer', 'https://logos.composio.dev/api/commerce_layer', 'a50211024021b52b9785cbf29bf66142c969cd64ceb28c71f4548673a9c72235', 'ba27e329067e611860a278ff48cc30a1f03fd82edd90bd2d3f6f990e959c27a3'],
      ['shopify-admin', 'Shopify Admin', 'shopify', 'https://logos.composio.dev/api/shopify', '5742f66b2b0f0eb4d5bcaa958ce4517d569f8699196bc08639db1bc1c4980481', '76f322d4790d613ada8c909ffa349b23be7009cc4e9cf26ef6b0d981a77f53ed'],
      ['constant-contact', 'Constant Contact', 'constant_contact', 'https://logos.composio.dev/api/constant_contact', 'd0a1c16fe82b534f6aacef072df4bb578661153a6db3e2cce4cd7855edde38da', 'b7091e0974ba221bd5e9a906fd170cd0aab7d6a55f0c7f135968036ce16a9d5d'],
      ['lightspeed-x', 'Lightspeed Retail X-Series', 'lightspeed', 'https://logos.composio.dev/api/lightspeed', '58407a93ca989628b9dc9c4e7c621daca5dbb43b514e6813c5ff11d3a59040c0', '33ffb4e554ee0dce4e4b45e374dc3a544e331fabf43acca4d5746900b2534cef'],
      ['square', 'Square', 'square', 'https://logos.composio.dev/api/square', 'e419920e75ea7be17b0e4ba6fd0a2e9065fbc7588e34412e013d58d9258ff77c', 'eccfaa6d2a8e238b9bf13d42b1283dc3b2bdb8b397a18d8af3ed6ef076444a81'],
      ['instacart-shopping', 'Instacart Shopping', 'instacart', 'https://logos.composio.dev/api/instacart', 'd2a24f1a65535c85ebae2c1fe963d0add66032b133b3b5667b63264170d8bd8e', '9822f762cab9e8100ee10bcd3995e5f3d527dd766ecf34cb6a827ceb06cbfd5a'],
      ['reloadly', 'Reloadly', 'reloadly', 'https://logos.composio.dev/api/reloadly', '819dfc49bcfc50069855373d2562ccf92caefc340e59010e2fa4d2452f589980', '4300ca0dcaa4eff347c5f731f8a2c3ffd03b1bd174e68740c65c3f3a500728d6'],
      ['woocommerce', 'WooCommerce', 'woocommerce', 'https://woocommerce.com/wp-content/uploads/2025/01/woo-logos.zip', 'a59ff90335d8ca3d13b53b93630445a8aba3e187869245adad80c3ac52628842', '470bb34f1d1fe8786d0ff85106d12c4b390c13cbd2ab783f16d3c68a655fc199'],
      ['walmart-marketplace', 'Walmart Marketplace', 'walmart', 'https://brandcenter.walmart.com/content/brand/us/en/home/brand-identity/spark/_jcr_content/root/container/side_rail/side_rail_right/block_container_1611011839/block_container_1641/block_container/columns/column_2/block_container/image.coreimg.svg/1736219744107/spark.svg', '9f8231afe91fb3127012c9c24cbb909e6d7f818adbb55cd0b9b42e427ba2a639', '9dcd0760e9e0179b39e9e15019fe1d81fffd8bdffd273dcf2fe386189786f459'],
      ['ebay-seller', 'eBay Seller', 'ebay', 'https://raw.githubusercontent.com/eBay/evo-web/main/packages/skin/src/svg/icon/icon-ebay-logo-16-colored.svg', '8f3fa022bc3473955bdec8d5df77cf796ee9bab5bbd20f907b0c66322152fa35', 'a1b80a2f8999fd9f4133e1fff7023413cf5c696974b2cad9c3c5fcca1dd6a6ad'],
      ['etsy-seller', 'Etsy Seller', 'etsy', 'https://extfiles.etsy.com/Press/brand-assets/etsy-logos.zip', 'a371bd03d03b3e44b69d8b43e1dce3fb0560a3c7a40a5371afee7126d5db59e1', '1fa5b6c27a2789b6cbe8d803309dbdf26c2b6f7144be2a6abbb24c38f3b7939d'],
      ['amazon-seller-central', 'Amazon Seller Central', 'amazon_seller', 'https://m.media-amazon.com/images/G/01/sell/navigation/amazon-logo-squid-menu.svg', '96038972ba58d1017a9af408b95ced924c903221b7450bf4d64e7d715ae5fe39', 'e48fd1a8ae2be2e70ffc38bb4232bb97d7b96d27c58c0c616aaccfd5dfd359c1'],
      ['mercado-libre-global-selling', 'Mercado Libre Global Selling', 'mercado_libre', 'https://http2.mlstatic.com/frontend-assets/ml-web-navigation/ui-navigation/5.21.22/mercadolibre/favicon.svg', 'bb35b84df3737ebb9f2449ce08e87c9efddfc810f1d3466bb67c251f97d6d4eb', '36ee428bb38ecfae06db166983518265b0028f047b8cb986b193eb8f7364f904'],
    ] as const;

    for (const [id, displayName, provider, sourceUrl, sourceHash, inlineHash] of expected) {
      const entry = catalog.findCatalogEntry(id);
      expect(entry).toMatchObject({
        id,
        display_name: displayName,
        category: 'commerce',
        auth_mode: 'local_api',
        local_api: { provider },
        transport_template: {
          kind: 'stdio',
          command: '${ORKAS_NODE}',
          args: ['${ORKAS_PC_DIR}/bin/direct-commerce-mcp-server.cjs'],
        },
        icon_source_url: sourceUrl,
        icon_source_sha256: sourceHash,
      });
      const expectedTools = [...direct.DIRECT_COMMERCE_TOOLS];
      expect(entry?.allowed_tools).toEqual(expectedTools);
      expect(Object.keys(entry?.tool_policies || {}).sort()).toEqual(
        expectedTools.sort(),
      );
      expect(entry?.tool_policies?.execute_read).toMatchObject({ risk: 'R', confirmation: 'none' });
      {
        expect(entry?.tool_policies).toMatchObject({
          execute_write: { risk: 'W', confirmation: 'preview' },
          execute_high_impact: { risk: 'H', confirmation: 'fresh' },
          execute_destructive: { risk: 'D', confirmation: 'destructive' },
        });
      }
      expect(entry?.icon_svg).toMatch(/^<svg(?:\s|>)/i);
      expect(entry?.icon_svg).toContain('width="100%"');
      expect(entry?.icon_svg).toContain('height="100%"');
      expect(entry?.icon_svg).not.toMatch(/<(?:script|foreignObject|iframe|image|use)\b/i);
      expect(createHash('sha256').update(entry?.icon_svg || '').digest('hex')).toBe(inlineHash);
      expect(entry?.connection_setup?.fields.filter((field) => field.storage === 'credential').length)
        .toBeGreaterThan(0);
    }

    const setupHeavyIds = [
      'shopee',
      'tiktok-shop',
      'bigcommerce', 'shopline', 'shoplazza',
      'magento', 'temu-seller', 'lazada-seller', 'shein-seller', 'alibaba-com-seller', 'aliexpress-seller',
      'rakuten-rms', 'base-shop', 'qoo10-japan', 'futureshop', 'yahoo-shopping',
      'commerce-layer',
      'shopify-admin',
      'constant-contact',
      'ebay-seller',
      'etsy-seller',
      'amazon-seller-central',
      'mercado-libre-global-selling',
      'taobao-tmall-seller', 'alibaba-1688-seller', 'jd-seller', 'pinduoduo-seller',
      'douyin-shop-seller', 'kuaishou-shop-seller', 'youzan-seller', 'weimob-wos-seller', 'xiaohongshu-seller',
    ];
    expect(direct.DIRECT_COMMERCE_ENTRIES
      .filter((entry) => entry.connection_setup?.requirement)
      .map((entry) => entry.id)).toEqual(setupHeavyIds);
    for (const id of setupHeavyIds) {
      expect(catalog.findCatalogEntry(id)?.connection_setup).toMatchObject({
        requirement: id === 'douyin-shop-seller' ? 'business_qualification' : 'provider_application',
      });
    }
    for (const id of setupHeavyIds) {
      expect(catalog.findCatalogEntry(id)?.connection_setup).toMatchObject({
        instructions_zh: expect.any(String),
        instructions_en: expect.any(String),
        guide_url: expect.stringMatching(/^https:\/\//),
        guide_label_zh: expect.any(String),
        guide_label_en: expect.any(String),
      });
    }

    expect(catalog.findCatalogEntry('shopify-admin')?.connection_setup?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'shop_domain', storage: 'metadata' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
      ]));
    expect(catalog.findCatalogEntry('commerce-layer')).toMatchObject({
      local_api: { provider: 'commerce_layer' },
      connection_setup: {
        guide_url: 'https://docs.commercelayer.io/core/api-credentials',
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'organization_slug', storage: 'metadata', format: 'commerce_layer_slug' }),
          expect.objectContaining({ key: 'client_id', storage: 'credential' }),
          expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
        ]),
      },
    });
    expect(catalog.findCatalogEntry('commerce-layer')?.requires_credits).toBeUndefined();
    expect(catalog.findCatalogEntry('constant-contact')?.connection_setup?.fields)
      .toEqual([expect.objectContaining({ key: 'client_id', storage: 'credential' })]);
    expect(catalog.findCatalogEntry('reloadly')?.connection_setup?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'product', input: 'choice', storage: 'metadata' }),
      ]));
    expect(catalog.findCatalogEntry('square')?.connection_setup?.fields)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'access_token', input: 'secret', storage: 'credential' }),
      ]));
    expect(catalog.findCatalogEntry('instacart-shopping')).toMatchObject({
      description_en: expect.stringContaining('merchant orders and inventory are not available'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'api_key', input: 'secret', storage: 'credential', format: 'instacart_api_key' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('woocommerce')).toMatchObject({
      auth_mode: 'local_api',
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'store_url', storage: 'metadata', format: 'woocommerce_store_url' }),
        expect.objectContaining({ key: 'consumer_key', storage: 'credential', format: 'woocommerce_consumer_key', required: true }),
        expect.objectContaining({ key: 'consumer_secret', input: 'secret', storage: 'credential', format: 'woocommerce_consumer_secret', required: true }),
      ]) },
    });
    expect(catalog.findCatalogEntry('walmart-marketplace')).toMatchObject({
      description_en: expect.stringContaining('approved seller account'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'market', storage: 'metadata', format: 'walmart_market' }),
        expect.objectContaining({ key: 'client_id', storage: 'credential' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('ebay-seller')).toMatchObject({
      description_en: expect.stringContaining('official OAuth'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'marketplace_id', storage: 'metadata', format: 'ebay_marketplace' }),
        expect.objectContaining({ key: 'content_language', storage: 'metadata', format: 'ebay_content_language' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
        expect.objectContaining({ key: 'ru_name', storage: 'credential', format: 'ebay_ru_name' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('etsy-seller')).toMatchObject({
      description_en: expect.stringContaining('Seller API Access'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'shop_id', storage: 'metadata', format: 'etsy_shop_id' }),
        expect.objectContaining({ key: 'keystring', storage: 'credential', format: 'etsy_keystring' }),
        expect.objectContaining({ key: 'shared_secret', input: 'secret', storage: 'credential' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('amazon-seller-central')).toMatchObject({
      description_en: expect.stringContaining('required business roles'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'marketplace_id', storage: 'metadata', format: 'amazon_marketplace' }),
        expect.objectContaining({ key: 'seller_id', storage: 'metadata', format: 'amazon_seller_id' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
        expect.objectContaining({ key: 'refresh_token', input: 'secret', storage: 'credential', format: 'amazon_refresh_token' }),
      ]) },
    });
    expect(catalog.findCatalogEntry('amazon-seller-central')?.connection_setup?.instructions_en)
      .toContain('Order contacts require Amazon-approved roles');
    expect(catalog.findCatalogEntry('amazon-seller-central')?.connection_setup?.instructions_en)
      .toContain('additional RDT and grantless authorization workflows are excluded');
    expect(catalog.findCatalogEntry('amazon-seller-central')?.connection_setup?.fields
      .find((field) => field.key === 'marketplace_id')?.options).toHaveLength(23);
    expect(catalog.findCatalogEntry('mercado-libre-global-selling')).toMatchObject({
      description_en: expect.stringContaining('official OAuth with PKCE'),
      connection_setup: { fields: expect.arrayContaining([
        expect.objectContaining({ key: 'user_id', storage: 'metadata', format: 'mercado_libre_user_id' }),
        expect.objectContaining({ key: 'client_id', storage: 'credential' }),
        expect.objectContaining({ key: 'client_secret', input: 'secret', storage: 'credential' }),
      ]) },
    });
    for (const id of [
      'taobao-tmall-seller',
      'alibaba-1688-seller',
      'jd-seller',
      'pinduoduo-seller',
      'douyin-shop-seller',
      'kuaishou-shop-seller',
      'youzan-seller',
      'weimob-wos-seller',
      'xiaohongshu-seller',
    ]) {
      expect(catalog.findCatalogEntry(id), id).toMatchObject({ auth_mode: 'local_api' });
    }

  });
});
