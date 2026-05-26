#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var minimist_1 = __importDefault(require("minimist"));
var index_1 = require("./index");
var argv = minimist_1.default(process.argv.slice(2));
if (!argv.input) {
    throw new Error('please pass --input to your rrweb events file');
}
var RESERVED_TOP = new Set(["fps", "headless", "ffmpeg", "output", "input"]);
var fileConfig = {};
if (argv.config) {
    var configPath = path.isAbsolute(argv.config)
        ? argv.config
        : path.resolve(process.cwd(), argv.config);
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (typeof fileConfig !== "object" || fileConfig === null) {
        throw new Error("config file must contain a JSON object");
    }
}
var rrwebPlayer = Object.assign({}, fileConfig);
RESERVED_TOP.forEach(function (k) {
    delete rrwebPlayer[k];
});
var fpsArg = argv.fps != null ? Number(argv.fps) : undefined;
if (fpsArg !== undefined && (isNaN(fpsArg) || fpsArg <= 0)) {
    throw new Error("--fps must be a positive number");
}
function resolveHeadless(argvVal, fileVal) {
    if (argvVal === false || argvVal === "false" || argvVal === 0) {
        return false;
    }
    if (argvVal === true || argvVal === "true") {
        return true;
    }
    return fileVal;
}
index_1.transformToVideo({
    input: argv.input,
    output: argv.output || fileConfig.output,
    fps: fpsArg !== undefined ? fpsArg : fileConfig.fps,
    headless: resolveHeadless(argv.headless, fileConfig.headless),
    ffmpeg: fileConfig.ffmpeg,
    rrwebPlayer: rrwebPlayer,
})
    .then(function (file) {
    console.log("Successfully transformed into \"" + file + "\".");
})
    .catch(function (error) {
    console.log('Failed to transform this session.');
    console.error(error);
    process.exit(1);
});
