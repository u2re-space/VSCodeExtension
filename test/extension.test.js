import assert from 'assert';
import vscodeAPI from '../src/imports/api.ts';

//
suite('Extension Test Suite', async () => {
	await (await vscodeAPI)?.window?.showInformationMessage?.('Start all tests.');
	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
