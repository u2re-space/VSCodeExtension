import assert from 'assert';
import path from 'path';

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
});
