import test from "node:test";
import assert from "node:assert/strict";
import { categorizeFile, analyzeLink } from "../src/categorize.js";

test("จัดหมวดไฟล์อัตโนมัติ", () => {
  assert.equal(categorizeFile("ใบงาน.docx", ""), "document");
  assert.equal(categorizeFile("slide.pptx", ""), "presentation");
  assert.equal(categorizeFile("คะแนน.xlsx", ""), "spreadsheet");
  assert.equal(categorizeFile("a.PDF", ""), "pdf");
  assert.equal(categorizeFile("x", "video/mp4"), "video");
  assert.equal(categorizeFile("song.mp3", ""), "audio");
  assert.equal(categorizeFile("pic.heic", ""), "image");
  assert.equal(categorizeFile("pack.zip", ""), "archive");
  assert.equal(categorizeFile("model.stl", ""), "other");
});

test("จัดหมวดลิงก์", () => {
  const yt = analyzeLink("https://youtu.be/dQw4w9WgXcQ");
  assert.equal(yt.category, "video");
  assert.equal(yt.embed, "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(analyzeLink("https://docs.google.com/presentation/d/abc123/edit").category, "presentation");
  assert.equal(analyzeLink("https://www.canva.com/design/DAF/xyz/view").provider, "canva");
  assert.equal(analyzeLink("https://example.com/").category, "link");
  assert.equal(analyzeLink("javascript:alert(1)"), null);
});
