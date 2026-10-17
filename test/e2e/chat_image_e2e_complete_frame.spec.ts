import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { expect } from './fixtures/orkas';
import { test } from './fixtures/web-app-eval';


// Visible source landmarks, rather than a CSS keyword, distinguish complete
// framing from cover/crop. Keep them inset from rounded edges and viewer actions.
const colors = ['#e53040', '#24b050', '#3050e0', '#e0b020'];
async function assertCorners(png: Buffer, locations: Array<{ x: number; y: number }>, palette = colors) {
  const image = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const [index, point] of locations.entries()) {
    const x = Math.floor(point.x), y = Math.floor(point.y);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(image.info.width);
    expect(y).toBeLessThan(image.info.height);
    const offset = (y * image.info.width + x) * image.info.channels;
    const expected = palette[index].slice(1).match(/../g)!.map(hex => parseInt(hex, 16));
    // Display color conversion may alter RGB; it cannot remove a landmark.
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(image.data[offset + channel] - expected[channel])).toBeLessThan(35);
    }
  }
}

test('preserves every corner from chat through native preview, resize and zoom reset', async ({ sdkOrkas: orkas }, info) => {
  const created: any = await orkas.invoke('conversations.create', { title: 'Complete image framing' });
  const cid = created.conversation.conversation_id;
  const page = orkas.page!;
  for (const [width, height] of [[1080, 1080], [1080, 2160], [2160, 1080]]) {
    const points = [
      { x: 200, y: 200 }, { x: width - 200, y: 200 },
      { x: 200, y: height - 200 }, { x: width - 200, y: height - 200 },
    ];
    const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#f5f5f5"/>
      ${points.map((p, i) => `<rect x="${p.x - 40}" y="${p.y - 40}" width="80" height="80" fill="${colors[i]}"/>`).join('')}
      </svg>`)).png().toBuffer();
    const file = path.join(orkas.userWorkspaceRoot, `corners-${width}-${height}.png`);
    writeFileSync(file, png);
    appendFileSync(path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`), JSON.stringify({
      id: `corners-${width}-${height}`, from: 'commander', to: ['user'], ts: new Date().toISOString(),
      text: `![Complete frame](${file})`,
    }) + '\n');
    await page.evaluate(async id => {
      await (window as any).loadConversations();
      await (window as any).setView('conversation', id);
    }, cid);
    const chatImage = page.locator('#chat-history img.chat-md-img').last();
    await expect.poll(() => chatImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(width);
    await expect(chatImage).toHaveCSS('opacity', '1');
    // Tall images require transcript scrolling. Element screenshots cannot
    // reveal portions clipped by a scrolling ancestor; inspect each end in view.
    const chatBox = (await chatImage.boundingBox())!;
    expect(Math.abs(chatBox.width / chatBox.height - width / height)).toBeLessThan(0.01);
    for (const [index, point] of points.entries()) {
      await chatImage.evaluate(async (img, args) => {
        const history = img.closest('.chat-history')! as HTMLElement;
        const box = img.getBoundingClientRect(), parent = history.getBoundingClientRect();
        const previous = history.style.scrollBehavior;
        history.style.scrollBehavior = 'auto';
        history.scrollTop += box.y + args.y * box.height / args.height - parent.y - parent.height / 2;
        history.style.scrollBehavior = previous;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, { y: point.y, height });
      const box = (await chatImage.boundingBox())!;
      const screenshot = await page.screenshot({ path: info.outputPath(`chat-${width}-${height}-${index}.png`), scale: 'css' });
      await assertCorners(screenshot, [{ x: box.x + point.x * box.width / width, y: box.y + point.y * box.height / height }], [colors[index]]);
    }
    const preview = await orkas.openPreview(() => chatImage.click());
    const image = preview.locator('.chat-lightbox-img');
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([width, height]);
    const native = await orkas.electronApp!.browserWindow(preview);
    for (const size of [[740, 540], [480, 640]]) {
      await native.evaluate((win, size) => win.setContentSize(size[0], size[1]), size);
      await expect.poll(() => preview.evaluate(() => [innerWidth, innerHeight])).toEqual(size);
      await preview.keyboard.press('+');
      await expect(image).not.toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
      await preview.keyboard.press('0');
      await expect(image).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
      const box = (await image.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size[0]);
      expect(box.y + box.height).toBeLessThanOrEqual(size[1]);
      const screenshot = await preview.screenshot({ path: info.outputPath(`preview-${width}-${height}-${size[0]}.png`), scale: 'css' });
      await assertCorners(screenshot, points.map(p => ({ x: box.x + p.x * box.width / width, y: box.y + p.y * box.height / height })));
    }
    // The preview resource must retain the exact source, not a thumbnail.
    const served = await image.evaluate(async (img: HTMLImageElement) => Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
    expect(Buffer.from(served)).toEqual(png);
    if (width > height) {
      const box = (await image.boundingBox())!;
      await image.evaluate((img: HTMLImageElement) => { img.style.width = '100%'; img.style.height = '100%'; img.style.objectFit = 'cover'; });
      const cropped = await preview.screenshot({ scale: 'css' });
      await expect(assertCorners(cropped, points.map(p => ({ x: box.x + p.x * box.width / width, y: box.y + p.y * box.height / height })))).rejects.toThrow();
    }
    await orkas.closePreview(preview);
    // Image links become previews too. A same-message link beside an identical
    // embed is intentionally deduplicated, so exercise the link-only entry.
    appendFileSync(path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`), JSON.stringify({
      id: `original-${width}-${height}`, from: 'commander', to: ['user'], ts: new Date().toISOString(),
      text: `[Open original](${file})`,
    }) + '\n');
    await page.evaluate(async id => { await (window as any).setView('conversation', id); }, cid);
    const originalImage = page.locator('#chat-history img.chat-md-img').last();
    await expect(originalImage).toHaveAttribute('alt', 'Open original');
    const original = await orkas.openPreview(() => originalImage.click());
    const originalBytes = await original.locator('.chat-lightbox-img').evaluate(async (img: HTMLImageElement) =>
      Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
    expect(Buffer.from(originalBytes)).toEqual(png);
    await orkas.closePreview(original);
    expect(readFileSync(file)).toEqual(png);
  }
});
