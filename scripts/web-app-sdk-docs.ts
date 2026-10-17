/** Both authoring references are generated from the executable API registry. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { catalogDocument } from '../src/main/features/web_apps/catalog';

const targets = [
  'docs/reference/web-app-sdk.json',
  'resources/builtin/system/skills/web-app-sdk/references/api.json',
];
export function syncWebAppSdkDocs(root: string, check: boolean): void {
  const web=JSON.stringify(catalogDocument('web'),null,2)+'\n';
  const copies=[...targets.map(relative=>({relative,content:JSON.stringify(catalogDocument(),null,2)+'\n'})),{relative:'resources/builtin/system/skills/web-app-sdk/references/web-api.json',content:web}];
  for (const {relative,content:expected} of copies) {
    const target = path.resolve(root, relative);
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== expected) {
        throw new Error(`Web SDK reference is stale: ${relative}. Run npm run web-app-sdk:docs.`);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, expected);
    }
  }
}
if (require.main === module) {
  const check = process.argv.includes('--check');
  syncWebAppSdkDocs(path.resolve(__dirname, '..'), check);
  console.log(check ? 'Web SDK references match the executable registry.' : 'Updated both Web SDK references.');
}
