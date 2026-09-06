import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as managerModule from '../src/views/manager.ts';

const Directory = 2;
const File = 1;
const SymbolicLink = 64;

suite('Manager module symlink helpers', () => {
    test('treats directory symlinks as directories', () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        assert.strictEqual(helpers.isDirectoryType(Directory), true);
        assert.strictEqual(helpers.isDirectoryType(Directory | SymbolicLink), true);
        assert.strictEqual(helpers.isDirectoryType(File), false);
        assert.strictEqual(helpers.isDirectoryType(File | SymbolicLink), false);
    });

    test('prefers the in-workspace real path over the symlink path', () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        assert.strictEqual(
            helpers.pickModuleRel('./modules/projects/alias', './packages/fest-core'),
            './packages/fest-core'
        );
        assert.strictEqual(
            helpers.pickModuleRel('./modules/projects/alias', '../fest-core'),
            '../fest-core'
        );
        assert.strictEqual(
            helpers.pickModuleRel('./modules/projects/alias', null),
            './modules/projects/alias'
        );
    });

    test('computes a relative path to the original project directory', () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        assert.strictEqual(
            helpers.relFromWorkspaceFs(
                path.resolve('/Projects/workspace'),
                path.resolve('/Projects/fest-core')
            ),
            '../fest-core'
        );
        assert.strictEqual(
            helpers.relFromWorkspaceFs(
                path.resolve('/Projects/workspace'),
                path.resolve('/Projects/workspace/packages/fest-core')
            ),
            './packages/fest-core'
        );
        assert.strictEqual(
            helpers.relFromWorkspaceFs(
                path.resolve('/a/b/c/d'),
                path.resolve('/a')
            ),
            null
        );
    });

    test('labels a project symlink with the relative path of the original directory', () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        assert.strictEqual(
            helpers.moduleDisplayLabel(
                './modules/projects/alias',
                path.resolve('/Projects/fest-core'),
                path.resolve('/Projects/workspace')
            ),
            '../fest-core'
        );
        assert.strictEqual(
            helpers.moduleDisplayLabel(
                './modules/projects/fest-core',
                path.resolve('/Projects/fest-core')
            ),
            './modules/projects/fest-core'
        );
    });

    test('rejects flag-like ghosts and missing module directories', () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        assert.strictEqual(helpers.isValidModulePath('--force'), false);
        assert.strictEqual(helpers.isValidModulePath('./apps/--force'), false);
        assert.strictEqual(helpers.isValidModulePath('./apps/web'), true);

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vext-mgr-'));
        try {
            fs.mkdirSync(path.join(tmp, 'apps'));
            fs.mkdirSync(path.join(tmp, 'apps', 'web'));
            assert.deepStrictEqual(
                helpers.filterLiveModules(tmp, [
                    './',
                    './apps/web',
                    './apps/--force',
                    '--force',
                    './apps/gone',
                ]),
                ['./', './apps/web']
            );
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('resolves action cwd to the original project path', () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        const linkFs = path.resolve('/repo/modules/projects/alias');
        const originalFs = path.resolve('/Projects/fest-core');
        const resolved = helpers.resolveActionFsPath(linkFs, () => originalFs);

        assert.strictEqual(resolved, originalFs);
    });
});
