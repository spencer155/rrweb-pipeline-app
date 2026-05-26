"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformToVideo = void 0;

var fs = require("fs");
var path = require("path");
var child_process = require("child_process");
var puppeteer = require("puppeteer");

var playerScriptPath = path.resolve(require.resolve("bxs-rrweb-player-2"), "../../dist/index.js");
var playerStylePath = path.resolve(playerScriptPath, "../style.css");
var playerRaw = fs.readFileSync(playerScriptPath, "utf-8");
var playerStyle = fs.readFileSync(playerStylePath, "utf-8");

var defaultConfig = {
    fps: 24,
    headless: true,
    input: "",
    cb: function () { },
    output: "rrvideo-output.mp4",
    rrwebPlayer: {},
    ffmpeg: {
        codec: "libx264",
        preset: "medium",
        crf: 20,
        pixFmt: "yuv420p",
        gopSeconds: 1,
        tune: null,
        profile: null,
        level: null,
        bitrate: null,
        extraArgs: [],
    },
};

function escapeScriptContent(value) {
    return JSON.stringify(value).replace(/<\/script>/g, "<\\/script>");
}

function getMeta(events) {
    var first = events[0];
    var last = events[events.length - 1];
    var meta = events.find(function (event) { return event && event.type === 4 && event.data; }) || first || {};
    var width = Number(meta.data && meta.data.width) || 1024;
    var height = Number(meta.data && meta.data.height) || 576;
    var startTime = Number(first && first.timestamp) || 0;
    var endTime = Number(last && last.timestamp) || startTime;
    return {
        width: width,
        height: height,
        startTime: startTime,
        endTime: endTime,
        duration: Math.max(0, endTime - startTime),
    };
}

function getHtml(events, playerConfig, size) {
    var showTimeStamp = playerConfig && playerConfig.showTimeStamp !== false;
    var timestampRight = Number(playerConfig && playerConfig.timestampRgihtWidth) || 20;
    var props = Object.assign({
        events: events,
        width: size.width,
        height: size.height,
        maxScale: 1,
        autoPlay: false,
        showController: false,
        showTimeStamp: true,
    }, playerConfig || {});

    return "\n<html>\n" +
        "  <head>\n" +
        "    <meta charset=\"utf-8\" />\n" +
        "    <style>\n" + playerStyle + "\n" +
        "      html, body { margin: 0; padding: 0; width: " + size.width + "px; height: " + size.height + "px; overflow: hidden; background: #fff; }\n" +
        "      body > .rr-player { margin: 0 !important; }\n" +
        "      .rrvideo-timestamp { position: absolute; top: 32px; right: " + timestampRight + "px; z-index: 2147483647; color: #c48a2c; font-size: 15px; font-family: Arial, sans-serif; line-height: 1; pointer-events: none; }\n" +
        "    </style>\n" +
        "  </head>\n" +
        "  <body>\n" +
        (showTimeStamp ? "    <div id=\"rrvideo-timestamp\" class=\"rrvideo-timestamp\"></div>\n" : "") +
        "    <script>\n" + playerRaw + ";\n" +
        "      const props = " + escapeScriptContent(props) + ";\n" +
        "      function pad(value) { return String(value).padStart(2, '0'); }\n" +
        "      window.__rrvideoSetTimestamp = function(timestamp) {\n" +
        "        const el = document.getElementById('rrvideo-timestamp');\n" +
        "        if (!el) return;\n" +
        "        const date = new Date(timestamp);\n" +
        "        el.textContent = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;\n" +
        "      };\n" +
        "      window.__rrvideoFinished = false;\n" +
        "      window.replayer = new rrwebPlayer({ target: document.body, props });\n" +
        "      window.replayer.addEventListener('finish', () => { window.__rrvideoFinished = true; });\n" +
        "      window.__rrvideoReady = true;\n" +
        "    </script>\n" +
        "  </body>\n" +
        "</html>\n";
}

function delay(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}

function writeFrame(stream, buffer) {
    return new Promise(function (resolve, reject) {
        stream.write(buffer, function (error) {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function runFfmpeg(config, frameWriter) {
    return new Promise(function (resolve, reject) {
        var outputPath = path.isAbsolute(config.output)
            ? config.output
            : path.resolve(process.cwd(), config.output);
        var fps = Math.max(1, Number(config.fps) || 24);
        var ff = Object.assign({}, defaultConfig.ffmpeg, config.ffmpeg || {});
        var gopFrames = ff.gop != null
            ? Math.max(1, Math.round(Number(ff.gop)))
            : Math.max(1, Math.round(fps * (Number(ff.gopSeconds) > 0 ? Number(ff.gopSeconds) : 1)));
        var codec = String(ff.codec || "libx264");
        var args = [
            "-hide_banner",
            "-loglevel", "warning",
            "-framerate", String(fps),
            "-f", "image2pipe",
            "-i", "-",
            "-y",
            "-r", String(fps),
            "-threads", "0",
        ];
        args.push("-c:v", codec);
        if (codec === "libx264" || codec === "libx265") {
            args.push(
                "-preset", String(ff.preset != null ? ff.preset : "medium"),
                "-crf", String(ff.crf != null ? ff.crf : 20),
                "-g", String(gopFrames),
                "-keyint_min", String(Math.min(gopFrames, fps)),
                "-sc_threshold", "0",
            );
            if (ff.tune) {
                args.push("-tune", String(ff.tune));
            }
            if (ff.profile) {
                args.push("-profile:v", String(ff.profile));
            }
            if (ff.level) {
                args.push("-level", String(ff.level));
            }
        }
        else if (codec === "h264_videotoolbox") {
            var vtBr = ff.bitrate != null ? String(ff.bitrate) : "4M";
            args.push("-b:v", vtBr, "-g", String(gopFrames));
            if (ff.profile) {
                args.push("-profile:v", String(ff.profile));
            }
        }
        else if (ff.bitrate) {
            args.push("-b:v", String(ff.bitrate), "-g", String(gopFrames));
        }
        args.push("-pix_fmt", String(ff.pixFmt || "yuv420p"));
        args.push("-movflags", "+faststart");
        if (Array.isArray(ff.extraArgs) && ff.extraArgs.length) {
            ff.extraArgs.forEach(function (a) {
                args.push(String(a));
            });
        }
        args.push(outputPath);
        var ffmpegProcess = child_process.spawn("ffmpeg", args);
        var settled = false;

        ffmpegProcess.stderr.setEncoding("utf-8");
        ffmpegProcess.stderr.on("data", function (chunk) {
            process.stderr.write(chunk);
        });
        ffmpegProcess.on("error", function (error) {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        ffmpegProcess.on("close", function (code) {
            if (settled) {
                return;
            }
            settled = true;
            if (code === 0) {
                resolve(outputPath);
                return;
            }
            reject(new Error("ffmpeg exited with code " + code));
        });

        Promise.resolve()
            .then(function () { return frameWriter(ffmpegProcess.stdin); })
            .then(function () { ffmpegProcess.stdin.end(); })
            .catch(function (error) {
                ffmpegProcess.stdin.destroy(error);
                reject(error);
            });
    });
}

function RRvideo(config) {
    config = config || {};
    var f = Number(config.fps);
    var fps = config.fps != null && !isNaN(f) && f > 0 ? f : defaultConfig.fps;
    this.config = {
        fps: fps,
        headless: config.headless !== undefined ? config.headless : defaultConfig.headless,
        input: config.input || defaultConfig.input,
        cb: config.cb || defaultConfig.cb,
        output: config.output || defaultConfig.output,
        rrwebPlayer: config.rrwebPlayer || defaultConfig.rrwebPlayer,
        ffmpeg: Object.assign({}, defaultConfig.ffmpeg, config.ffmpeg || {}),
    };
}

RRvideo.prototype.init = async function () {
    var browser;
    try {
        var eventsPath = path.isAbsolute(this.config.input)
            ? this.config.input
            : path.resolve(process.cwd(), this.config.input);
        var events = JSON.parse(fs.readFileSync(eventsPath, "utf-8"));
        if (!Array.isArray(events) || events.length === 0) {
            throw new Error("input must be a non-empty rrweb events array");
        }

        var meta = getMeta(events);
        var playerConfig = Object.assign({}, this.config.rrwebPlayer);
        var size = {
            width: Number(playerConfig.width) || meta.width,
            height: Number(playerConfig.height) || meta.height,
        };
        var outputSize = {
            width: size.width % 2 === 0 ? size.width : size.width + 1,
            height: size.height % 2 === 0 ? size.height : size.height + 1,
        };
        var endHoldMs = Number(playerConfig.endHoldMs || playerConfig.tailMs || 0);
        var captureMode = playerConfig.captureMode || "timeline";
        var renderDelayMs = Number(playerConfig.renderDelayMs != null ? playerConfig.renderDelayMs : 20);
        delete playerConfig.endHoldMs;
        delete playerConfig.tailMs;
        delete playerConfig.captureMode;
        delete playerConfig.renderDelayMs;
        playerConfig.width = size.width;
        playerConfig.height = size.height;
        playerConfig.showController = false;
        playerConfig.autoPlay = false;

        browser = await puppeteer.launch({ headless: this.config.headless });
        var page = await browser.newPage();
        page.setDefaultNavigationTimeout(0);
        await page.setViewport({ width: outputSize.width, height: outputSize.height, deviceScaleFactor: 1 });
        await page.goto("about:blank");
        await page.setContent(getHtml(events, playerConfig, size), { waitUntil: "domcontentloaded", timeout: 0 });
        await page.waitForFunction("window.__rrvideoReady === true && window.replayer", { timeout: 0 });
        await page.waitForSelector(".rr-player, .replayer-wrapper", { timeout: 0 });
        await delay(300);

        var frameInterval = 1000 / this.config.fps;
        var self = this;
        var outputPath = await runFfmpeg(this.config, async function (stdin) {
            if (captureMode === "play") {
                var frame = 0;
                var startedAt = Date.now();
                var maxCaptureMs = Math.max(meta.duration + endHoldMs + 5000, 10000);
                await page.evaluate(function (absoluteTimestamp) {
                    window.__rrvideoFinished = false;
                    window.__rrvideoSetTimestamp(absoluteTimestamp);
                    window.replayer.goto(0, false);
                    window.replayer.play();
                }, meta.startTime);
                while (Date.now() - startedAt <= maxCaptureMs) {
                    var frameStartedAt = Date.now();
                    var buffer = await page.screenshot({
                        encoding: "binary",
                        clip: { x: 0, y: 0, width: outputSize.width, height: outputSize.height },
                    });
                    await writeFrame(stdin, buffer);
                    frame += 1;
                    self.config.cb("", null, { frame: frame });
                    var finished = await page.evaluate(function () { return window.__rrvideoFinished === true; });
                    if (finished) {
                        break;
                    }
                    await delay(Math.max(0, frameInterval - (Date.now() - frameStartedAt)));
                }
                var playHoldFrames = Math.max(0, Math.ceil(endHoldMs / frameInterval));
                for (var playHold = 0; playHold < playHoldFrames; playHold += 1) {
                    var playHoldBuffer = await page.screenshot({
                        encoding: "binary",
                        clip: { x: 0, y: 0, width: outputSize.width, height: outputSize.height },
                    });
                    await writeFrame(stdin, playHoldBuffer);
                    self.config.cb("", null, { frame: frame + playHold + 1 });
                }
                return;
            }
            var frameCount = Math.max(1, Math.ceil(((meta.duration + endHoldMs) / 1000) * self.config.fps) + 1);
            for (var i = 0; i < frameCount; i += 1) {
                var offset = Math.min(meta.duration, Math.round(i * frameInterval));
                await page.evaluate(function (timeOffset, absoluteTimestamp) {
                    return new Promise(function (resolve) {
                        window.__rrvideoSetTimestamp(absoluteTimestamp);
                        window.replayer.goto(timeOffset, false);
                        requestAnimationFrame(function () {
                            requestAnimationFrame(resolve);
                        });
                    });
                }, offset, meta.startTime + offset);
                await delay(Math.max(0, renderDelayMs));
                var timelineBuffer = await page.screenshot({
                    encoding: "binary",
                    clip: { x: 0, y: 0, width: outputSize.width, height: outputSize.height },
                });
                await writeFrame(stdin, timelineBuffer);
                self.config.cb("", null, { frame: i + 1, totalFrames: frameCount, timeOffset: offset });
            }
        });

        await browser.close();
        this.config.cb(outputPath, null);
    }
    catch (error) {
        if (browser) {
            try {
                await browser.close();
            }
            catch (_) { }
        }
        this.config.cb("", error);
    }
};

function transformToVideo(config) {
    return new Promise(function (resolve, reject) {
        var rrvideo = new RRvideo(Object.assign({}, config, {
            cb: function (file, error) {
                if (error) {
                    reject(error);
                    return;
                }
                if (file) {
                    resolve(file);
                }
            },
        }));
        rrvideo.init();
    });
}
exports.transformToVideo = transformToVideo;
