function hello(context) {
	console.log('Congratulations, your extension "gtpview" is now active!');
	const disposable = vscode.commands.registerCommand('gtpview.helloWorld', function () {
		vscode.window.showInformationMessage('Hello World from GTP-view!');
	});
	context.subscriptions.push(disposable);
}
