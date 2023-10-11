/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

const path = require('path');

/** @type WebpackConfig */
const browserClientConfig = {
	mode: 'none',
	target: 'webworker', // web extensions run in a webworker context
	entry: {
		extension: './src/extension.ts',
	},
	resolve: {
		mainFields: ['module', 'main'],
		extensions: ['.ts', '.js'], // support ts-files and js-files
		alias: {},
		fallback: {
            "util": require.resolve("util/"),
			"path": require.resolve("path-browserify")
		},
	},
	output: {
		libraryTarget: 'commonjs2',
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader',
					},
				],
			},
		],
	},
	externals: {
		vscode: 'commonjs vscode', // ignored because it doesn't exist
	},
	performance: {
		hints: false,
	},
	devtool: 'source-map',
};

/** @type WebpackConfig */
const browserServerConfig = {
	mode: 'none',
	target: 'webworker', // web extensions run in a webworker context
	entry: {
		server: './src/server.ts',
		serverProcess: './src/serverProcess.ts',
	},
	resolve: {
		mainFields: ['module', 'main'],
		extensions: ['.ts', '.js'], // support ts-files and js-files
		alias: {},
		fallback: {
            "util": require.resolve("util/"),
			"path": require.resolve("path-browserify"),
			"url": require.resolve("url/")
		},
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader',
					},
				],
			}
		],
	},
	output: {
		libraryTarget: 'commonjs2',
	},
	performance: {
		hints: false,
	},
	devtool: 'source-map',
};

module.exports = [browserClientConfig, browserServerConfig];