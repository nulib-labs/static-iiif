const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HLS_FORMAT,
  mediaKindFromExtension,
  parseSourceKey,
  mediaStatusKey,
  buildJobSettings,
  s3UriToPublicUrl,
  summarizeCompletedJob,
} = require("../av");
const {publishDocument} = require("../publish");

const BUCKET = "kdid-dev-iiif";
const BASE = "https://d111.cloudfront.net";

test("media kind comes from the extension, case-insensitively", () => {
  assert.equal(mediaKindFromExtension("MOV"), "video");
  assert.equal(mediaKindFromExtension(".mp4"), "video");
  assert.equal(mediaKindFromExtension("wav"), "audio");
  assert.equal(mediaKindFromExtension("tif"), null);
  assert.equal(mediaKindFromExtension(""), null);
});

test("parseSourceKey accepts only av/{workId}/{assetId}.{ext}", () => {
  assert.deepEqual(parseSourceKey("av/work-1/0b6f-4c2a.MP4"), {
    workId: "work-1",
    assetId: "0b6f-4c2a",
    ext: "mp4",
    kind: "video",
  });
  // Recognized shape, unknown type: parsed, so the Lambda can report it.
  assert.equal(parseSourceKey("av/work-1/abc.xyz").kind, null);
  assert.equal(parseSourceKey("image/work-1/abc.jpg"), null);
  assert.equal(parseSourceKey("av/work-1/nested/abc.mp4"), null);
  assert.equal(parseSourceKey("av/../abc.mp4"), null);
  assert.equal(parseSourceKey("av/work-1/abc"), null);
});

test("status lives beside the outputs", () => {
  assert.equal(mediaStatusKey("work-1", "abc"), "av/work-1/abc/media.json");
});

test("video jobs: automated ABR HLS with separate audio, plus a poster", () => {
  const settings = buildJobSettings({
    kind: "video",
    inputUri: "s3://src/av/w/a.mov",
    destination: `s3://${BUCKET}/av/w/a`,
  });
  const [hls, poster] = settings.OutputGroups;
  assert.equal(hls.OutputGroupSettings.HlsGroupSettings.Destination, `s3://${BUCKET}/av/w/a/index`);
  assert.ok(hls.AutomatedEncodingSettings.AbrSettings);
  const video = hls.Outputs.find((output) => output.VideoDescription);
  const audio = hls.Outputs.find((output) => output.AudioDescriptions);
  // Automated ABR refuses a video output that also carries audio, or one with
  // a fixed size — the ladder is the service's to choose.
  assert.equal(video.AudioDescriptions, undefined);
  assert.equal(video.VideoDescription.Width, undefined);
  assert.equal(video.VideoDescription.CodecSettings.H264Settings.RateControlMode, "QVBR");
  assert.equal(video.OutputSettings.HlsSettings.AudioRenditionSets, audio.OutputSettings.HlsSettings.AudioGroupId);
  assert.equal(poster.Outputs[0].VideoDescription.CodecSettings.Codec, "FRAME_CAPTURE");
  assert.ok(settings.Inputs[0].VideoSelector);
});

test("audio jobs: one audio-only HLS output and nothing else", () => {
  const settings = buildJobSettings({kind: "audio", inputUri: "s3://src/av/w/a.wav", destination: "s3://b/av/w/a"});
  assert.equal(settings.OutputGroups.length, 1);
  const [hls] = settings.OutputGroups;
  assert.equal(hls.AutomatedEncodingSettings, undefined);
  assert.equal(hls.Outputs.length, 1);
  assert.equal(hls.Outputs[0].VideoDescription, undefined);
  assert.equal(settings.Inputs[0].VideoSelector, undefined);
});

test("buildJobSettings refuses an unknown kind", () => {
  assert.throws(() => buildJobSettings({kind: null, inputUri: "s3://a/b", destination: "s3://a/c"}));
});

test("s3UriToPublicUrl maps only this bucket", () => {
  assert.equal(
    s3UriToPublicUrl(`s3://${BUCKET}/av/w/a/index.m3u8`, {bucket: BUCKET, baseUrl: `${BASE}/`}),
    `${BASE}/av/w/a/index.m3u8`,
  );
  assert.equal(s3UriToPublicUrl("s3://other/av/w/a/index.m3u8", {bucket: BUCKET, baseUrl: BASE}), null);
  // A bucket whose name is a prefix of ours must not match.
  assert.equal(s3UriToPublicUrl(`s3://${BUCKET}x/av/a`, {bucket: BUCKET, baseUrl: BASE}), null);
});

const videoDetail = {
  status: "COMPLETE",
  outputGroupDetails: [
    {
      type: "HLS_GROUP",
      playlistFilePaths: [`s3://${BUCKET}/av/w/a/index.m3u8`],
      outputDetails: [
        {durationInMs: 93400, videoDetails: {widthInPx: 640, heightInPx: 360}},
        {durationInMs: 93412, videoDetails: {widthInPx: 1920, heightInPx: 1080}},
        {durationInMs: 93450},
      ],
    },
    {
      type: "FILE_GROUP",
      outputDetails: [
        {outputFilePaths: [`s3://${BUCKET}/av/w/a/poster.0000001.jpg`], videoDetails: {widthInPx: 1920, heightInPx: 1080}},
      ],
    },
  ],
};

test("a completed video job summarizes to the largest rendition and its poster", () => {
  assert.deepEqual(summarizeCompletedJob(videoDetail, {kind: "video", bucket: BUCKET, baseUrl: BASE}), {
    status: "ready",
    kind: "video",
    format: HLS_FORMAT,
    streamUrl: `${BASE}/av/w/a/index.m3u8`,
    duration: 93.45,
    width: 1920,
    height: 1080,
    poster: {url: `${BASE}/av/w/a/poster.0000001.jpg`, width: 1920, height: 1080},
  });
});

test("a completed audio job has a duration and no dimensions", () => {
  const detail = {
    outputGroupDetails: [
      {type: "HLS_GROUP", playlistFilePaths: [`s3://${BUCKET}/av/w/a/index.m3u8`], outputDetails: [{durationInMs: 5000}]},
    ],
  };
  const summary = summarizeCompletedJob(detail, {kind: "audio", bucket: BUCKET, baseUrl: BASE});
  assert.equal(summary.duration, 5);
  assert.equal(summary.width, undefined);
  assert.equal(summary.poster, undefined);
});

test("a completed job with no playlist is an error, not a silent empty canvas", () => {
  assert.throws(() => summarizeCompletedJob({outputGroupDetails: []}, {kind: "audio", bucket: BUCKET, baseUrl: BASE}));
});

// The property the whole design leans on: media sits under IIIF_BASE_URL but
// outside both spaces, so publishing rewrites the canvas and not the stream.
test("publishing leaves av/ URLs alone", () => {
  const stream = `${BASE}/av/w/a/index.m3u8`;
  const canvasId = `${BASE}/working/presentation/manifest/w/canvas/1`;
  const manifest = {
    id: `${BASE}/working/presentation/manifest/w/manifest.json`,
    items: [{id: canvasId, items: [{items: [{target: canvasId, body: {id: stream, type: "Video"}}]}]}],
  };
  const {document} = publishDocument(manifest, {from: `${BASE}/working`, to: `${BASE}/published`});
  const annotation = document.items[0].items[0].items[0];
  assert.equal(annotation.body.id, stream);
  assert.equal(annotation.target, `${BASE}/published/presentation/manifest/w/canvas/1`);
});
