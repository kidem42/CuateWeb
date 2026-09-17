#!/usr/bin/env python3
"""Package verified compiled workspaces, public sources, and dependency notices.

Does not build, install dependencies, start services, or include local credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

root = Path(__file__).resolve().parents[1]
required = ['client/dist/index.html', 'packages/api/dist/index.cjs',
            'packages/data-provider/dist/index.js', 'packages/data-schemas/dist/index.cjs',
            'packages/client/dist/index.cjs']
for name in required:
    if not (root / name).is_file():
        raise SystemExit(f'Missing built artifact: {name}. Run npm run frontend first.')
paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached'], cwd=root).decode().split('\0')
files = set()
for name in paths:
    path = Path(name)
    if not name or not (root / path).is_file() or (root / path).is_symlink():
        continue
    # Only reviewed, tracked sources belong in a distribution. Ignore rules alone
    # do not protect credentials that were accidentally tracked.
    if path.parts[0] in {'artifacts', 'private', '.codex', '.agents', '.claude'}:
        continue
    if (path.name.startswith('.env') and path.name not in {'.env.example', '.env.test.example'}) or path.name in {'AGENTS.override.md', 'librechat.yaml', 'librechat.yml'} or path.suffix in {'.pem', '.key'}:
        continue
    files.add(path)
for directory in ['client/dist', 'packages/api/dist', 'packages/data-provider/dist', 'packages/data-schemas/dist', 'packages/client/dist']:
    files.update(path.relative_to(root) for path in (root / directory).rglob('*') if path.is_file() and not path.is_symlink())

notices = ['CuateWeb build dependency notices\n',
           'This inventory includes the installed development and runtime dependency tree.\n'
           'It is not a declaration that every listed package is included in every bundle.\n'
           'Original upstream license files in the source archive remain authoritative.\n']
seen = set()
for directory, dirs, names in os.walk(root):
    relative = Path(directory).relative_to(root)
    if relative.parts and relative.parts[0] in {'.git', 'artifacts', 'private'}:
        dirs[:] = []
        continue
    if 'node_modules' not in relative.parts or 'package.json' not in names:
        continue
    try:
        manifest = json.loads((Path(directory) / 'package.json').read_text())
    except (ValueError, OSError):
        continue
    identity = (manifest.get('name', ''), manifest.get('version', ''))
    if not identity[0] or identity in seen:
        continue
    seen.add(identity)
    notices.append(f'\n=== {identity[0]} {identity[1]} ===\nDeclared license: {manifest.get("license", "not declared")}\n')
    for name in sorted(names):
        if name.lower().split('.')[0] not in {'license', 'licence', 'notice', 'copyright', 'copying'}:
            continue
        file = Path(directory) / name
        if file.is_file():
            notices.append(f'\n{name}\n{file.read_text(errors="replace")}\n')

output = root / 'artifacts'
output.mkdir(exist_ok=True)
archive = output / 'CuateWeb-test.tar.gz'
manifest = {str(path): hashlib.sha256((root / path).read_bytes()).hexdigest() for path in sorted(files)}
with tempfile.TemporaryDirectory(prefix='cuateweb-package-') as staging:
    stage = Path(staging)
    (stage / 'THIRD_PARTY_NOTICES.txt').write_text(''.join(notices))
    (stage / 'BUILD-MANIFEST.json').write_text(json.dumps({
        'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
        'uncommittedTestBuild': True,
        'files': manifest,
    }, indent=2) + '\n')
    with tarfile.open(archive, 'w:gz') as tar:
        for path in sorted(files):
            tar.add(root / path, arcname=str(Path('cuateweb') / path), recursive=False)
        for path in stage.iterdir():
            tar.add(path, arcname=f'cuateweb/{path.name}')
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(archive.with_suffix(archive.suffix + '.sha256')).write_text(f'{checksum}  {archive.name}\n')
print(f'{archive}\nSHA256 {checksum}\n{len(files)} files; {len(seen)} dependency notices')
