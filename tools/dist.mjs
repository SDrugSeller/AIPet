// 설치 파일을 만든다: 일반 배포판과 디버그판(동작 로그 파일을 남기는 판) 둘 다.
//   node tools/dist.mjs            둘 다 (일반 → 디버그)
//   node tools/dist.mjs release    일반판만
//   node tools/dist.mjs debug      디버그판만
//
//   dist/AIPet-Setup-<버전>.exe              일반 배포판
//   dist/debug/AIPet-Setup-<버전>-debug.exe  디버그판 (같은 앱 ID라 일반판 위에 덮어 설치할 수 있다)
//
// 디버그판은 package.json에 aipetBuild:"debug"를 넣어 빌드한다 (extraMetadata). 코드는 같다.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js', { paths: [root] });

const VARIANTS = {
  release: ['--win', 'nsis'],
  debug: [
    '--win',
    'nsis',
    '--config.extraMetadata.aipetBuild=debug',
    '--config.directories.output=dist/debug',
    '--config.nsis.artifactName=AIPet-Setup-${version}-debug.${ext}',
  ],
};

const want = process.argv[2];
if (want && !(want in VARIANTS)) {
  console.error(`알 수 없는 종류: ${want} (release | debug)`);
  process.exit(2);
}

for (const name of want ? [want] : Object.keys(VARIANTS)) {
  console.log(`\n===== ${name} 빌드 =====`);
  const r = spawnSync(process.execPath, [cli, ...VARIANTS[name]], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${name} 빌드 실패 (종료 코드 ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
