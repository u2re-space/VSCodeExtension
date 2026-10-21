import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as managerModule from '../src/views/manager.ts';

const Directory = 2;
const File = 1;
const SymbolicLink = 64;

function makeUri(fsPath) {
    return {
        scheme: 'file',
        authority: '',
        fsPath,
        path: fsPath.replace(/\\/g, '/'),
    };
}

function createFakeVscode() {
    return {
        FileType: { File, Directory, SymbolicLink },
        Uri: {
            joinPath(base, ...segments) {
                return makeUri(path.join(base.fsPath, ...segments));
            },
        },
        workspace: {
            fs: {
                async stat(uri) {
                    if (uri.fsPath.includes('denied')) {
                        const error = new Error('permission denied');
                        error.code = 'EACCES';
                        throw error;
                    }
                    const st = fs.statSync(uri.fsPath);
                    return { type: st.isDirectory() ? Directory : File };
                },
            },
        },
    };
}

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

    test('rejects flag-like ghosts and missing module directories', async () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        assert.strictEqual(helpers.isValidModulePath('--force'), false);
        assert.strictEqual(helpers.isValidModulePath('./apps/--force'), false);
        assert.strictEqual(helpers.isValidModulePath('./apps/web'), true);
        assert.strictEqual(helpers.isValidModulePath('../sibling'), true);
        assert.strictEqual(helpers.isValidModulePath('../../sibling'), true);
        assert.strictEqual(helpers.isValidModulePath('../../../etc'), false);
        assert.strictEqual(helpers.isValidModulePath('./../../../../etc'), false);

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vext-mgr-'));
        try {
            fs.mkdirSync(path.join(tmp, 'apps'));
            fs.mkdirSync(path.join(tmp, 'apps', 'web'));
            const vscodeApi = createFakeVscode();
            assert.deepStrictEqual(
                await helpers.filterLiveModules(vscodeApi, makeUri(tmp), [
                    './',
                    './apps/web',
                    './apps/--force',
                    '--force',
                    './apps/gone',
                ]),
                ['./', './apps/web']
            );
            // An access error must not delete a module: keep it instead of guessing.
            assert.deepStrictEqual(
                await helpers.filterLiveModules(vscodeApi, makeUri(tmp), ['./apps/denied']),
                ['./', './apps/denied']
            );
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('computes workspace-relative paths from remote URIs', () => {
        const helpers = managerModule.__managerTest;
        assert.ok(helpers, 'expected manager test helpers to be exported');

        const ws = {
            scheme: 'vscode-remote',
            authority: 'ssh-remote+host',
            path: '/home/user/ws',
        };
        assert.strictEqual(
            helpers.moduleRelFromUri(ws, { ...ws, path: '/home/user/ws/modules/app' }),
            './modules/app'
        );
        assert.strictEqual(
            helpers.moduleRelFromUri(ws, { ...ws, path: '/home/user/ws' }),
            './'
        );
        assert.strictEqual(
            helpers.moduleRelFromUri(ws, { ...ws, path: '/home/user/other' }),
            '../other'
        );
        assert.strictEqual(
            helpers.moduleRelFromUri(ws, { ...ws, path: '/srv/other' }),
            null
        );
        assert.strictEqual(
            helpers.moduleRelFromUri(ws, { ...ws, authority: 'ssh-remote+other', path: '/home/user/ws/modules/app' }),
            null
        );
        assert.strictEqual(
            helpers.moduleRelFromUri(ws, { ...ws, path: '/home/user/ws/node_modules/pkg' }),
            null
        );
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
