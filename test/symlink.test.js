import assert from 'assert';
import path from 'path';
import fs from 'fs';
import os from 'os';

import * as symlinkModule from '../src/explorer/symlink.ts';

suite('Symlink path helpers', () => {
    test('resolves ../ sources against workspace roots before destination dir', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const existing = new Set([
            path.resolve('/repo/../shared/pkg'),
        ]);

        const resolved = helpers.resolveSourcePath(
            '../shared/pkg',
            path.resolve('/repo/app/nested'),
            [path.resolve('/repo')],
            (p) => existing.has(path.resolve(p))
        );

        assert.strictEqual(resolved, path.resolve('/shared/pkg'));
    });

    test('computes new relative symlink target from the real destination directory', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const rel = helpers.relativeSymlinkTarget(
            path.resolve('/repo/modules/link-parent'),
            path.resolve('/repo/assets/icon.svg'),
            (p) => p === path.resolve('/repo/modules/link-parent')
                ? path.resolve('/real/modules/parent')
                : path.resolve(p)
        );

        assert.strictEqual(rel, '../../../repo/assets/icon.svg');
    });

    test('normalizes absolute targets inside symlinked directories using the real parent', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const normalized = helpers.normalizeSymlinkTarget(
            path.resolve('/repo/modules/link-parent/child-link'),
            path.resolve('/real/shared/target'),
            (p) => p === path.resolve('/repo/modules/link-parent')
                ? path.resolve('/real/modules/parent')
                : path.resolve(p)
        );

        assert.deepStrictEqual(normalized, {
            changed: true,
            resolvedTargetFs: path.resolve('/real/shared/target'),
            relTarget: '../../shared/target',
        });
    });

    test('normalizes relative targets inside symlinked directories against the real parent', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const normalized = helpers.normalizeSymlinkTarget(
            path.resolve('/repo/modules/link-parent/child-link'),
            '../shared/./target',
            (p) => p === path.resolve('/repo/modules/link-parent')
                ? path.resolve('/real/modules/parent')
                : path.resolve(p)
        );

        assert.deepStrictEqual(normalized, {
            changed: true,
            resolvedTargetFs: path.resolve('/real/modules/shared/target'),
            relTarget: '../shared/target',
        });
    });

    test('uses exact user-provided name for a single symlink instead of pre-deduping', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const dir = path.resolve('/repo/app');
        const existing = new Set([path.join(dir, 'source')]);

        const linkPath = helpers.linkPathForName(
            dir,
            'custom-link',
            false,
            (p) => existing.has(path.resolve(p))
        );

        assert.strictEqual(linkPath, path.join(dir, 'custom-link'));
    });

    test('auto-deduplicates batch symlink names', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const dir = path.resolve('/repo/app');
        const existing = new Set([path.join(dir, 'source')]);

        const linkPath = helpers.linkPathForName(
            dir,
            'source',
            true,
            (p) => existing.has(path.resolve(p))
        );

        assert.strictEqual(linkPath, path.join(dir, 'source (2)'));
    });

    test('rename-and-relink swaps the renamed resource and rewrites targets inside it', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const oldDir = path.resolve('/repo/assets/old-name');
        const newDir = path.resolve('/repo/assets/new-name');

        // Exact match → new resource path.
        assert.strictEqual(
            helpers.newTargetFor(oldDir, newDir, oldDir),
            newDir
        );

        // A target inside the renamed directory keeps its suffix.
        const insideTarget = path.join(oldDir, 'sub', 'icon.svg');
        assert.strictEqual(
            helpers.newTargetFor(oldDir, newDir, insideTarget),
            path.join(newDir, 'sub', 'icon.svg')
        );

        // A sibling that only shares a name prefix is left untouched (not matched upstream).
        const sibling = path.resolve('/repo/assets/old-name-extra');
        assert.notStrictEqual(
            helpers.newTargetFor(oldDir, newDir, sibling),
            path.join(newDir, '-extra')
        );
    });

    test('readStubLinkTarget restores a stub file whose content is a directory path', () => {
        const helpers = symlinkModule.__symlinkTest;
        assert.ok(helpers, 'expected symlink test helpers to be exported');

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vext-stub-'));
        try {
            const targetDir = path.join(tmp, 'target');
            fs.mkdirSync(targetDir);

            const stubAbs = path.join(tmp, 'link-abs');
            fs.writeFileSync(stubAbs, targetDir + '\n');
            assert.strictEqual(helpers.readStubLinkTarget(stubAbs), targetDir);

            const stubRel = path.join(tmp, 'link-rel');
            fs.writeFileSync(stubRel, './target');
            assert.strictEqual(helpers.readStubLinkTarget(stubRel), './target');

            const stubNoNewline = path.join(tmp, 'link-plain');
            fs.writeFileSync(stubNoNewline, 'target');
            assert.strictEqual(helpers.readStubLinkTarget(stubNoNewline), 'target');

            // Multi-line content is not a stub.
            const stubMulti = path.join(tmp, 'link-multi');
            fs.writeFileSync(stubMulti, 'target\nextra');
            assert.strictEqual(helpers.readStubLinkTarget(stubMulti), undefined);

            // Target pointing to a non-directory is not a stub.
            const filePath = path.join(tmp, 'a-file');
            fs.writeFileSync(filePath, 'x');
            const stubToFile = path.join(tmp, 'link-to-file');
            fs.writeFileSync(stubToFile, filePath);
            assert.strictEqual(helpers.readStubLinkTarget(stubToFile), undefined);

            // Target that does not exist is not a stub.
            const stubMissing = path.join(tmp, 'link-missing');
            fs.writeFileSync(stubMissing, path.join(tmp, 'nope'));
            assert.strictEqual(helpers.readStubLinkTarget(stubMissing), undefined);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
