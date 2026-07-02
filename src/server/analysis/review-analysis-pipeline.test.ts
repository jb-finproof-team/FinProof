import type { ReviewCase } from "@/domain/types";
import {
  createGeminiOcrProvider,
  createHybridOcrProvider,
  createOpenAiOcrProvider,
  createPythonServiceOcrProvider,
  createReviewAnalysisPipeline,
  selectEvidenceCandidates
} from "./review-analysis-pipeline";
import type { RagEvidenceCandidate } from "./review-analysis-pipeline";
import type { ModelProvider } from "@/server/ai/model-provider";
import type { ReviewStoreScope } from "@/server/reviews";
import type { ReviewSubAgentOrchestrator } from "./review-subagents";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const review: ReviewCase = {
  id: "rc-upload-001",
  title: "실제 업로드 적금 홍보물",
  affiliate: "광주은행",
  productType: "deposit",
  channelType: ["poster"],
  plannedPublishDate: "2026-06-20",
  status: "analysis_waiting",
  highestRiskLevel: "info",
  requester: "업로드 요청자",
  reviewer: "준법심의자",
  promotionalCopy: "최고 연 5.0% 우대금리",
  disclosure: "조건 충족 시 적용",
  productDescription: "우대금리는 급여이체 조건 충족 시 제공됩니다.",
  missingMaterials: [],
  files: [
    {
      id: "file-upload-001",
      name: "poster.png",
      fileType: "promotional_creative",
      classificationConfidence: 0.78,
      parseStatus: "pending",
      storageProvider: "s3",
      storageKey: "s3://finproof-s3/reviews/rc-upload-001/file-upload-001/poster.png",
      contentType: "image/png",
      sizeBytes: 1024
    }
  ],
  issues: [],
  expectedDraft: "검토 필요",
  currentVersion: 1
};

describe("review analysis pipeline", () => {
  it("strips NUL/control bytes from extracted text so Postgres can persist it", async () => {
    // Simulates a mis-encoded upload (e.g. UTF-16 Vietnamese text decoded as UTF-8),
    // where characters are interleaved with NUL bytes that Postgres rejects.
    const pipeline = createReviewAnalysisPipeline({
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "V\u0000a\u0000y\u0000 t\u0000i\u0000ề\u0000n\u0000 nhanh\u0001\u001f",
            confidence: 0.88,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    const artifacts = await pipeline.run({ review });

    const [document] = artifacts.extractedDocuments;
    expect(document.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(document.text).toContain("Vay tiền nhanh");
  });

  it("extracts OCR text and creates RAG evidence candidates", async () => {
    const pipeline = createReviewAnalysisPipeline({
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "최고 연 5.0% 우대금리는 급여이체 조건 충족 시 제공됩니다.",
            confidence: 0.91,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.extractedDocuments).toEqual([
      expect.objectContaining({
        fileId: "file-upload-001",
        text: expect.stringContaining("급여이체 조건"),
        confidence: 0.91,
        provider: "fixture-ocr"
      })
    ]);
    expect(artifacts.evidenceCandidates).toEqual([
      expect.objectContaining({
        id: "evidence-candidate-file-upload-001-001",
        sourceType: "product_doc",
        title: "poster.png",
        quoteSummary: expect.stringContaining("급여이체 조건"),
        relevanceScore: expect.any(Number)
      })
    ]);
  });

  it("extracts text from stored upload bodies before retrieval", async () => {
    const pipeline = createReviewAnalysisPipeline({
      fileBodyReader: {
        async getReviewFileBody(storageKey) {
          expect(storageKey).toBe("local/rc-upload-001/file-upload-001/poster.html");

          return new TextEncoder().encode(
            "<main><h1>누구나 최고 연 5.0%</h1><p>급여이체 등 우대 조건 충족 시 적용됩니다.</p></main>"
          );
        }
      }
    });

    const artifacts = await pipeline.run({
      review: {
        ...review,
        files: [
          {
            ...review.files[0],
            name: "poster.html",
            storageProvider: "local",
            storageKey: "local/rc-upload-001/file-upload-001/poster.html",
            contentType: "text/html"
          }
        ]
      }
    });

    expect(artifacts.extractedDocuments).toEqual([
      expect.objectContaining({
        fileName: "poster.html",
        provider: "local-text-extractor",
        text: expect.stringContaining("누구나 최고 연 5.0%"),
        confidence: 0.96
      })
    ]);
    expect(artifacts.evidenceCandidates[0]).toEqual(
      expect.objectContaining({
        quoteSummary: expect.stringContaining("우대 조건 충족")
      })
    );
  });

  it("extracts searchable text from stored PDF bodies before retrieval", async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), "finproof-pdftotext-"));
    const originalPath = process.env.PATH;
    const originalPdfToTextPath = process.env.FINPROOF_PDFTOTEXT_PATH;
    const fakePdfToText = path.join(binDir, "pdftotext");

    await writeFile(
      fakePdfToText,
      [
        "#!/bin/sh",
        "printf '%s\\n' '누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다. 급여이체와 자동이체 조건을 모두 충족해야 하며 세전 기준입니다.'"
      ].join("\n")
    );
    await chmod(fakePdfToText, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.FINPROOF_PDFTOTEXT_PATH = fakePdfToText;

    try {
      const pipeline = createReviewAnalysisPipeline({
        fileBodyReader: {
          async getReviewFileBody(storageKey) {
            expect(storageKey).toBe("local/rc-upload-001/file-upload-001/ad.pdf");

            return new TextEncoder().encode("%PDF-1.7 searchable pdf fixture");
          }
        }
      });

      const artifacts = await pipeline.run({
        review: {
          ...review,
          files: [
            {
              ...review.files[0],
              name: "ad.pdf",
              storageProvider: "local",
              storageKey: "local/rc-upload-001/file-upload-001/ad.pdf",
              contentType: "application/pdf"
            }
          ]
        }
      });

      expect(artifacts.extractedDocuments).toEqual([
        expect.objectContaining({
          fileName: "ad.pdf",
          provider: "local-pdf-text-extractor",
          text: expect.stringContaining("누구나 최고 연 5.0%"),
          confidence: 0.94
        })
      ]);
      expect(artifacts.evidenceCandidates[0]).toEqual(
        expect.objectContaining({
          quoteSummary: expect.stringContaining("우대 조건 충족")
        })
      );
    } finally {
      process.env.PATH = originalPath;
      process.env.FINPROOF_PDFTOTEXT_PATH = originalPdfToTextPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("discovers pdftotext from PATH when FINPROOF_PDFTOTEXT_PATH is not configured", async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), "finproof-pdftotext-path-"));
    const originalPath = process.env.PATH;
    const originalPdfToTextPath = process.env.FINPROOF_PDFTOTEXT_PATH;
    const fakePdfToText = path.join(binDir, "pdftotext");

    await writeFile(
      fakePdfToText,
      [
        "#!/bin/sh",
        "printf '%s\\n' 'PDF PATH 추출 성공 최고 연 5.0% 우대 조건 충족 시 적용됩니다. 급여이체와 자동이체 조건을 모두 충족해야 하며 세전 기준입니다.'"
      ].join("\n")
    );
    await chmod(fakePdfToText, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    delete process.env.FINPROOF_PDFTOTEXT_PATH;

    try {
      const pipeline = createReviewAnalysisPipeline({
        fileBodyReader: {
          async getReviewFileBody() {
            return new TextEncoder().encode("%PDF-1.7 searchable pdf fixture");
          }
        }
      });

      const artifacts = await pipeline.run({
        review: {
          ...review,
          files: [
            {
              ...review.files[0],
              name: "ad.pdf",
              storageProvider: "local",
              storageKey: "local/rc-upload-001/file-upload-001/ad.pdf",
              contentType: "application/pdf"
            }
          ]
        }
      });

      expect(artifacts.extractedDocuments).toEqual([
        expect.objectContaining({
          provider: "local-pdf-text-extractor",
          text: expect.stringContaining("PDF PATH 추출 성공")
        })
      ]);
    } finally {
      process.env.PATH = originalPath;
      process.env.FINPROOF_PDFTOTEXT_PATH = originalPdfToTextPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("preserves extraction diagnostics when uploaded PDF content is not analyzable", async () => {
    const originalPdfToTextPath = process.env.FINPROOF_PDFTOTEXT_PATH;

    process.env.FINPROOF_PDFTOTEXT_PATH = "/tmp/finproof-missing-pdftotext";

    try {
      const pipeline = createReviewAnalysisPipeline({
        fileBodyReader: {
          async getReviewFileBody() {
            return new TextEncoder().encode("%PDF-1.7 scanned pdf fixture");
          }
        }
      });

      const artifacts = await pipeline.run({
        review: {
          ...review,
          files: [
            {
              ...review.files[0],
              name: "대출광고.pdf",
              storageProvider: "local",
              storageKey: "local/rc-upload-001/file-upload-001/loan-ad.pdf",
              contentType: "application/pdf"
            }
          ]
        }
      });

      expect(artifacts.extractedDocuments).toEqual([]);
      expect(artifacts.extractionDiagnostics).toEqual([
        expect.objectContaining({
          fileId: "file-upload-001",
          fileName: "대출광고.pdf",
          provider: "metadata-only",
          reason: "extraction_unavailable",
          message: expect.stringContaining("현재 로컬 텍스트 추출 대상이 아니거나")
        })
      ]);
    } finally {
      process.env.FINPROOF_PDFTOTEXT_PATH = originalPdfToTextPath;
    }
  });

  it("does not route metadata-only notices to multilingual or domain agents when extracted text exists", async () => {
    const subAgentOrchestrator: ReviewSubAgentOrchestrator = {
      run: vi.fn(async () => [])
    };
    const provider: ModelProvider = {
      generateText: vi.fn(async () => ({
        provider: "fixture",
        model: "fixture",
        text: "[]"
      }))
    };
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator,
      ocrProvider: {
        async extract() {
          return [
            {
              fileId: "file-upload-archive",
              fileName: "package.zip",
              text: "CSV JSON Markdown uploaded body analysis unavailable",
              confidence: 0.62,
              provider: "metadata-only"
            },
            {
              fileId: "file-upload-001",
              fileName: "poster.txt",
              text: "누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
              confidence: 0.96,
              provider: "local-text-extractor"
            }
          ];
        }
      }
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.extractedDocuments).toEqual([
      expect.objectContaining({
        fileName: "poster.txt",
        provider: "local-text-extractor"
      })
    ]);
    expect(artifacts.multilingualSegments).toBeUndefined();
    expect(provider.generateText).not.toHaveBeenCalled();
    expect(subAgentOrchestrator.run).toHaveBeenCalledWith(
      expect.objectContaining({
        extractedDocuments: [
          expect.objectContaining({
            fileName: "poster.txt",
            provider: "local-text-extractor"
          })
        ]
      })
    );
  });

  it("does not route archive cover letters or submission check documents to review agents", async () => {
    const subAgentOrchestrator: ReviewSubAgentOrchestrator = {
      run: vi.fn(async () => [])
    };
    const provider = multilingualProviderReturning({});
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator,
      ocrProvider: {
        async extract() {
          return [
            {
              fileId: "file-upload-creative",
              fileName: "01_홍보물_시안_모바일배너.pdf",
              text: "낮은 금리로 갈아타고 최대한도 3억원",
              confidence: 0.94,
              provider: "fixture-ocr"
            },
            {
              fileId: "file-upload-submission-check",
              fileName: "00_FinProof_제출조건_확인서.pdf",
              text: [
                "FinProof 요청 제출 조건 확인서 productType=loan 필수자료 및 파일 분류 매핑",
                "SamplePackageSelector.tsx에서 fileType 기준으로 promotional_creative, rate_table을 확인합니다."
              ].join("\n"),
              confidence: 0.94,
              provider: "fixture-ocr"
            }
          ];
        }
      }
    });
    const uploadReview: ReviewCase = {
      ...review,
      productType: "loan",
      files: [
        {
          ...review.files[0],
          id: "file-upload-creative",
          name: "01_홍보물_시안_모바일배너.pdf",
          fileType: "promotional_creative",
          contentType: "application/pdf"
        },
        {
          ...review.files[0],
          id: "file-upload-submission-check",
          name: "00_FinProof_제출조건_확인서.pdf",
          fileType: "misc",
          contentType: "application/pdf"
        }
      ]
    };

    const artifacts = await pipeline.run({ review: uploadReview });

    expect(artifacts.extractedDocuments).toEqual([
      expect.objectContaining({
        fileId: "file-upload-creative",
        fileName: "01_홍보물_시안_모바일배너.pdf"
      })
    ]);
    expect(provider.calls).not.toContain("english_translator_risk");
    expect(subAgentOrchestrator.run).toHaveBeenCalledWith(
      expect.objectContaining({
        extractedDocuments: [
          expect.objectContaining({
            fileId: "file-upload-creative"
          })
        ]
      })
    );
  });

  it("does not route image metadata-only notices to review agents when image OCR text is unavailable", async () => {
    const subAgentOrchestrator: ReviewSubAgentOrchestrator = {
      run: vi.fn(async () => [])
    };
    const pipeline = createReviewAnalysisPipeline({
      subAgentOrchestrator,
      ocrProvider: {
        async extract() {
          return [
            {
              fileId: "file-upload-001",
              fileName: "loan-ad.jpeg",
              text: [
                "파일명: loan-ad.jpeg",
                "이 파일은 현재 로컬 텍스트 추출 대상이 아니거나 저장 본문을 읽을 수 없습니다."
              ].join("\n"),
              confidence: 0.62,
              provider: "metadata-only"
            }
          ];
        }
      }
    });

    const artifacts = await pipeline.run({
      review: {
        ...review,
        productType: "image_test",
        promotionalCopy: "",
        disclosure: "",
        productDescription: "",
        files: [
          {
            ...review.files[0],
            name: "loan-ad.jpeg",
            contentType: "image/jpeg"
          }
        ]
      }
    });

    expect(artifacts.extractedDocuments).toEqual([]);
    expect(subAgentOrchestrator.run).toHaveBeenCalledWith(
      expect.objectContaining({
        extractedDocuments: []
      })
    );
  });

  it("extracts visual file text with Gemini OCR using inline file bytes", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 fake pdf bytes");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      text: "최고 연 5.0%는 우대 조건 충족 시 적용됩니다.",
                      confidence: 0.93
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    }));
    const provider = createGeminiOcrProvider(
      {
        GEMINI_API_KEY: "gemini-real",
        FINPROOF_OCR_MODEL: "gemini-2.5-flash-lite"
      },
      {
        async getReviewFileBody(storageKey) {
          expect(storageKey).toBe("s3://finproof-s3/reviews/rc-upload-001/file-upload-001/ad.pdf");

          return pdfBytes;
        }
      },
      fetchImpl
    );

    const documents = await provider.extract({
      review,
      files: [
        {
          ...review.files[0],
          name: "ad.pdf",
          contentType: "application/pdf",
          storageKey: "s3://finproof-s3/reviews/rc-upload-001/file-upload-001/ad.pdf"
        }
      ]
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-goog-api-key": "gemini-real"
        })
      })
    );
    const requestInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(requestInit.body)) as {
      contents: { parts: Array<Record<string, unknown>> }[];
    };
    expect(payload.contents[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inlineData: {
            mimeType: "application/pdf",
            data: Buffer.from(pdfBytes).toString("base64")
          }
        })
      ])
    );
    expect(documents).toEqual([
      {
        fileId: "file-upload-001",
        fileName: "ad.pdf",
        storageKey: "s3://finproof-s3/reviews/rc-upload-001/file-upload-001/ad.pdf",
        text: "최고 연 5.0%는 우대 조건 충족 시 적용됩니다.",
        confidence: 0.93,
        provider: "gemini-ocr"
      }
    ]);
  });

  it("passes AbortSignal timeout to Gemini OCR fetch", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 fake");
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({ text: "광고 텍스트", confidence: 0.9 })
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    });

    const provider = createGeminiOcrProvider(
      { GEMINI_API_KEY: "test-key", FINPROOF_OCR_TIMEOUT_MS: "5000" },
      {
        async getReviewFileBody() {
          return pdfBytes;
        }
      },
      fetchImpl
    );

    await provider.extract({
      review,
      files: [
        {
          ...review.files[0],
          name: "ad.pdf",
          contentType: "application/pdf",
          storageKey: "s3://bucket/ad.pdf"
        }
      ]
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses Gemini Pro for OCR and uses Flash-Lite instead", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 fake");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ text: "광고 텍스트", confidence: 0.9 }) }]
              }
            }
          ]
        };
      }
    }));
    const provider = createGeminiOcrProvider(
      { GEMINI_API_KEY: "test-key", FINPROOF_OCR_MODEL: "gemini-2.5-pro" },
      {
        async getReviewFileBody() {
          return pdfBytes;
        }
      },
      fetchImpl
    );

    await provider.extract({
      review,
      files: [
        {
          ...review.files[0],
          name: "ad.pdf",
          contentType: "application/pdf",
          storageKey: "s3://bucket/ad.pdf"
        }
      ]
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
      expect.any(Object)
    );
  });

  it("extracts image text with OpenAI OCR responses", async () => {
    const imageBytes = new TextEncoder().encode("fake image bytes");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          output_text: JSON.stringify({
            text: "최고 연 5.0% 우대 조건 충족 시 적용",
            confidence: 0.92
          })
        };
      }
    }));
    const provider = createOpenAiOcrProvider(
      {
        OPENAI_API_KEY: "sk-real",
        FINPROOF_OCR_MODEL: "gpt-5-mini"
      },
      {
        async getReviewFileBody(storageKey) {
          expect(storageKey).toBe("s3://bucket/poster.png");
          return imageBytes;
        }
      },
      fetchImpl
    );

    const documents = await provider.extract({
      review,
      files: [
        {
          ...review.files[0],
          name: "poster.png",
          contentType: "image/png",
          storageKey: "s3://bucket/poster.png"
        }
      ]
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sk-real",
          "content-type": "application/json"
        })
      })
    );
    const requestInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(requestInit.body)) as {
      model: string;
      input: { content: Array<Record<string, unknown>> }[];
    };
    expect(payload.model).toBe("gpt-5-mini");
    expect(payload.input[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "input_text" }),
        expect.objectContaining({
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`
        })
      ])
    );
    expect(documents).toEqual([
      {
        fileId: "file-upload-001",
        fileName: "poster.png",
        storageKey: "s3://bucket/poster.png",
        text: "최고 연 5.0% 우대 조건 충족 시 적용",
        confidence: 0.92,
        provider: "openai-ocr"
      }
    ]);
  });

  it("sends image-only PDFs as OpenAI OCR file inputs", async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), "finproof-openai-pdf-"));
    const originalPdfToTextPath = process.env.FINPROOF_PDFTOTEXT_PATH;
    const fakePdfToText = path.join(binDir, "pdftotext");
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 image-only");

    await writeFile(fakePdfToText, ["#!/bin/sh", "printf '%s\\n' 'x'"].join("\n"));
    await chmod(fakePdfToText, 0o755);
    process.env.FINPROOF_PDFTOTEXT_PATH = fakePdfToText;

    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            output_text: JSON.stringify({ text: "PDF 포스터 문구", confidence: 0.88 })
          };
        }
      }));
      const provider = createOpenAiOcrProvider(
        {
          OPENAI_API_KEY: "sk-real",
          FINPROOF_OCR_MODEL: "gemini-2.5-flash-lite"
        },
        {
          async getReviewFileBody() {
            return pdfBytes;
          }
        },
        fetchImpl
      );

      const documents = await provider.extract({
        review,
        files: [
          {
            ...review.files[0],
            name: "poster.pdf",
            contentType: "application/pdf",
            storageKey: "s3://bucket/poster.pdf"
          }
        ]
      });

      const requestInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
      const payload = JSON.parse(String(requestInit.body)) as {
        model: string;
        input: { content: Array<Record<string, unknown>> }[];
      };
      expect(payload.model).toBe("gpt-5-mini");
      expect(payload.input[0]?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "input_file",
            filename: "poster.pdf",
            file_data: `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`
          })
        ])
      );
      expect(documents).toEqual([
        expect.objectContaining({
          fileName: "poster.pdf",
          text: "PDF 포스터 문구",
          confidence: 0.88,
          provider: "openai-ocr"
        })
      ]);
    } finally {
      process.env.FINPROOF_PDFTOTEXT_PATH = originalPdfToTextPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("renders image-only PDFs to page images before OpenAI OCR when pdftoppm is available", async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), "finproof-openai-pdf-render-"));
    const originalPdfToTextPath = process.env.FINPROOF_PDFTOTEXT_PATH;
    const originalPdfToPpmPath = process.env.FINPROOF_PDFTOPPM_PATH;
    const fakePdfToText = path.join(binDir, "pdftotext");
    const fakePdfToPpm = path.join(binDir, "pdftoppm");
    const renderedPageBytes = "rendered pdf page image";
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 image-only");

    await writeFile(fakePdfToText, ["#!/bin/sh", "printf '%s\\n' 'x'"].join("\n"));
    await writeFile(
      fakePdfToPpm,
      [
        "#!/bin/sh",
        "last=",
        'for arg in "$@"; do last="$arg"; done',
        `printf '%s' '${renderedPageBytes}' > \"$last-1.png\"`
      ].join("\n")
    );
    await chmod(fakePdfToText, 0o755);
    await chmod(fakePdfToPpm, 0o755);
    process.env.FINPROOF_PDFTOTEXT_PATH = fakePdfToText;
    process.env.FINPROOF_PDFTOPPM_PATH = fakePdfToPpm;

    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            output_text: JSON.stringify({ text: "렌더링된 PDF 페이지 문구", confidence: 0.9 })
          };
        }
      }));
      const provider = createOpenAiOcrProvider(
        {
          OPENAI_API_KEY: "sk-real",
          FINPROOF_OCR_MODEL: "gpt-5-mini",
          FINPROOF_PDFTOPPM_PATH: fakePdfToPpm
        },
        {
          async getReviewFileBody() {
            return pdfBytes;
          }
        },
        fetchImpl
      );

      await provider.extract({
        review,
        files: [
          {
            ...review.files[0],
            name: "poster.pdf",
            contentType: "application/pdf",
            storageKey: "s3://bucket/poster.pdf"
          }
        ]
      });

      const requestInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
      const payload = JSON.parse(String(requestInit.body)) as {
        input: { content: Array<Record<string, unknown>> }[];
      };
      expect(payload.input[0]?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "input_image",
            image_url: `data:image/png;base64,${Buffer.from(renderedPageBytes).toString("base64")}`
          })
        ])
      );
      expect(payload.input[0]?.content).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "input_file" })])
      );
    } finally {
      process.env.FINPROOF_PDFTOTEXT_PATH = originalPdfToTextPath;
      process.env.FINPROOF_PDFTOPPM_PATH = originalPdfToPpmPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("falls back to Gemini OCR when a promotional PDF has too little embedded text", async () => {
    const binDir = await mkdtemp(path.join(tmpdir(), "finproof-pdftotext-short-"));
    const originalPdfToTextPath = process.env.FINPROOF_PDFTOTEXT_PATH;
    const fakePdfToText = path.join(binDir, "pdftotext");
    const pdfBytes = new TextEncoder().encode("%PDF-1.7 image-only poster pdf fixture");

    await writeFile(fakePdfToText, ["#!/bin/sh", "printf '%s\\n' 'x'"].join("\n"));
    await chmod(fakePdfToText, 0o755);
    process.env.FINPROOF_PDFTOTEXT_PATH = fakePdfToText;

    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        text: "포스터 PDF 이미지에서 OCR로 읽은 최고 연 5.20% 문구",
                        confidence: 0.91
                      })
                    }
                  ]
                }
              }
            ]
          };
        }
      }));
      const provider = createGeminiOcrProvider(
        {
          GEMINI_API_KEY: "gemini-real",
          FINPROOF_OCR_MODEL: "gemini-2.5-flash-lite"
        },
        {
          async getReviewFileBody() {
            return pdfBytes;
          }
        },
        fetchImpl
      );

      const documents = await provider.extract({
        review,
        files: [
          {
            ...review.files[0],
            name: "poster.pdf",
            fileType: "promotional_creative",
            contentType: "application/pdf",
            storageKey: "local/rc-upload-001/poster.pdf"
          }
        ]
      });

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(documents).toEqual([
        expect.objectContaining({
          fileName: "poster.pdf",
          provider: "gemini-ocr",
          text: "포스터 PDF 이미지에서 OCR로 읽은 최고 연 5.20% 문구",
          confidence: 0.91
        })
      ]);
    } finally {
      process.env.FINPROOF_PDFTOTEXT_PATH = originalPdfToTextPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("prioritizes extracted document text over metadata-only archive entries", async () => {
    const pipeline = createReviewAnalysisPipeline({
      ocrProvider: {
        async extract() {
          return [
            {
              fileId: "file-upload-001",
              fileName: "package.zip",
              text: "파일명: package.zip 본문 추출 대상이 아닙니다.",
              confidence: 0.62,
              provider: "metadata-only"
            },
            {
              fileId: "file-upload-002",
              fileName: "poster.txt",
              text: "누구나 받을 수 있는 최고 연 5.0% 적금. 우대 조건 충족 시 적용됩니다.",
              confidence: 0.96,
              provider: "local-text-extractor"
            }
          ];
        }
      }
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.evidenceCandidates[0]).toEqual(
      expect.objectContaining({
        title: "poster.txt",
        quoteSummary: expect.stringContaining("최고 연 5.0%")
      })
    );
  });

  it("retrieves approved knowledge evidence and reranks every RAG candidate", async () => {
    const scope: ReviewStoreScope = {
      tenantId: "tenant-demo",
      actorUserId: "user-reviewer-demo",
      actorRole: "reviewer"
    };
    const searchKnowledgeEvidence = vi.fn(async () => [
      {
        id: "knowledge-evidence-001",
        sourceType: "internal_policy" as const,
        documentId: "knowledge-001",
        chunkId: "chunk-knowledge-001-001",
        title: "예금 광고 심의 지침",
        version: "2026.05",
        effectiveFrom: "2026-05-01",
        quoteSummary: "최고 금리 표현은 우대 조건과 한도를 같은 화면에 표시해야 합니다.",
        relevanceScore: 0.88
      }
    ]);
    const rerank = vi.fn(async ({ candidates }) =>
      [...candidates].sort((left, right) =>
        left.sourceType === "internal_policy" ? -1 : right.sourceType === "internal_policy" ? 1 : 0
      )
    );
    const pipeline = createReviewAnalysisPipeline({
      reviewStore: { searchKnowledgeEvidence },
      reranker: {
        provider: "fixture-reranker",
        rerank
      },
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
            confidence: 0.94,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    const artifacts = await pipeline.run({ review, scope });

    expect(searchKnowledgeEvidence).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        query: expect.stringContaining("최고 연 5.0%"),
        productType: "deposit",
        topK: expect.any(Number)
      })
    );
    expect(rerank).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("최고 연 5.0%"),
        candidates: expect.arrayContaining([
          expect.objectContaining({ sourceType: "product_doc" }),
          expect.objectContaining({ sourceType: "internal_policy" })
        ])
      })
    );
    expect(artifacts.evidenceCandidates[0]).toMatchObject({
      sourceType: "internal_policy",
      chunkId: "chunk-knowledge-001-001"
    });
  });

  it("builds the knowledge retrieval query from extracted document text, not only intake metadata", async () => {
    // Uploaded cases carry placeholder intake metadata; the real ad content only exists
    // in the OCR-extracted documents. Knowledge retrieval must query the extracted text.
    const scope: ReviewStoreScope = {
      tenantId: "tenant-demo",
      actorUserId: "user-reviewer-demo",
      actorRole: "reviewer"
    };
    const searchKnowledgeEvidence = vi.fn(async () => []);
    const pipeline = createReviewAnalysisPipeline({
      reviewStore: { searchKnowledgeEvidence },
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "매일더함 자유적금 최고금리 연 4.50% 급여이체 우대조건",
            confidence: 0.9,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    await pipeline.run({ review, scope });

    expect(searchKnowledgeEvidence).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        query: expect.stringContaining("매일더함 자유적금")
      })
    );
  });

  it("drops reranked evidence candidates below the configured matching threshold", async () => {
    const scope: ReviewStoreScope = {
      tenantId: "tenant-demo",
      actorUserId: "user-reviewer-demo",
      actorRole: "reviewer"
    };
    const searchKnowledgeEvidence = vi.fn(async () => [
      {
        id: "knowledge-evidence-low-rerank",
        sourceType: "internal_policy" as const,
        documentId: "knowledge-low-rerank",
        chunkId: "chunk-knowledge-low-rerank-011",
        title: "금융규제 가이드라인",
        quoteSummary: "추천·보증 등의 내용은 실제 경험한 사실에 부합하여야 한다.",
        relevanceScore: 0.88
      }
    ]);
    const rerank = vi.fn(async ({ candidates }) =>
      candidates.map((candidate) =>
        candidate.id === "knowledge-evidence-low-rerank"
          ? { ...candidate, relevanceScore: 0.03 }
          : candidate
      )
    );
    const pipeline = createReviewAnalysisPipeline({
      reviewStore: { searchKnowledgeEvidence },
      reranker: {
        provider: "fixture-reranker",
        rerank
      },
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
            confidence: 0.94,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    const artifacts = await pipeline.run({ review, scope });

    expect(artifacts.evidenceCandidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "knowledge-evidence-low-rerank",
          relevanceScore: 0.03
        })
      ])
    );
  });

  it("retrieves case history evidence from the review store when a scoped analysis runs", async () => {
    const scope: ReviewStoreScope = {
      tenantId: "tenant-demo",
      actorUserId: "user-reviewer-demo",
      actorRole: "reviewer"
    };
    const searchKnowledgeEvidence = vi.fn(async () => []);
    const searchCaseHistoryEvidence = vi.fn(async () => [
      {
        id: "case-history-evidence-001",
        sourceType: "case_history" as const,
        documentId: "rc-2025-014",
        title: "CASE-2025-014",
        quoteSummary: "유사한 최고금리 표현이 조건 고지 위치 문제로 수정 요청되었습니다.",
        relevanceScore: 0.9
      }
    ]);
    const provider: ModelProvider = {
      generateText: vi.fn(async ({ task }) => ({
        provider: "openai",
        model: "gpt-5.2",
        text:
          task === "creative_review"
            ? JSON.stringify([
                {
                  title: "최고 금리 조건 병기 필요",
                  riskLevel: "high",
                  targetText: "누구나 최고 연 5.0%",
                  description: "절대 표현과 최고 금리 표현이 함께 있어 조건 고지가 필요합니다.",
                  suggestedAction: "change_request",
                  suggestedCopy: "조건 충족 시 최고 연 5.0%로 문구를 조정해 주세요.",
                  evidenceCandidateIds: ["case-history-evidence-001"],
                  confidence: 0.86
                }
              ])
            : "[]"
      }))
    };
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      reviewStore: {
        searchKnowledgeEvidence,
        searchCaseHistoryEvidence
      },
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
            confidence: 0.94,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    const artifacts = await pipeline.run({ review, scope });

    expect(searchCaseHistoryEvidence).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        query: expect.stringContaining("최고 연 5.0%"),
        productType: "deposit",
        excludeReviewCaseId: "rc-upload-001"
      })
    );
    expect(artifacts.evidenceCandidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceType: "case_history" })])
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "case_search"
      })
    );
  });

  it("runs the default domain review subagents and stores their findings", async () => {
    const provider: ModelProvider = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({
          provider: "openai",
          model: "gpt-5.2",
          text: JSON.stringify([
            {
              title: "최고 금리 조건 병기 필요",
              riskLevel: "high",
              targetText: "누구나 최고 연 5.0%",
              description: "절대 표현과 최고 금리 표현이 함께 있어 조건 고지가 필요합니다.",
              suggestedAction: "change_request",
              suggestedCopy: "최고 연 5.0%는 우대 조건 충족 시 적용됩니다.",
              evidenceCandidateIds: ["evidence-candidate-file-upload-001-001"],
              confidence: 0.88
            }
          ])
        })
        .mockResolvedValue({
          provider: "openai",
          model: "gpt-5.2",
          text: "[]"
        })
    };
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
            confidence: 0.94,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    const artifacts = await pipeline.run({ review });

    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "creative_review",
        instructions: expect.stringContaining("FinProof creative_review agent"),
        routeContext: expect.objectContaining({
          riskLevel: "info"
        })
      })
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "creative_review",
        instructions: expect.stringContaining("Shared Common Risk Policy")
      })
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "product_terms",
        instructions: expect.stringContaining("FinProof product_terms agent")
      })
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "regulation_agent",
        instructions: expect.stringContaining("FinProof regulation_agent")
      })
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "internal_policy_agent",
        instructions: expect.stringContaining("FinProof internal_policy_agent")
      })
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "evidence_verification",
        instructions: expect.stringContaining("FinProof evidence_verification agent")
      })
    );
    expect(artifacts.agentFindings).toEqual([
      expect.objectContaining({
        agent: "creative_review",
        title: "최고 금리 조건 병기 필요",
        evidenceCandidateIds: ["evidence-candidate-file-upload-001-001"]
      })
    ]);
  });

  it("still runs the main compliance lead agent when low-risk domain findings are strongly evidenced", async () => {
    const provider: ModelProvider = {
      generateText: vi.fn(async ({ task }) => ({
        provider: "openai",
        model: "gpt-5.2",
        text:
          task === "creative_review"
            ? JSON.stringify([
                {
                  title: "혜택 조건 문구 확인",
                  riskLevel: "caution",
                  targetText: "최고 연 5.0%",
                  description: "조건 문구가 함께 있어 주의 수준으로 확인합니다.",
                  suggestedAction: "hold",
                  suggestedCopy: "우대 조건 충족 시 적용된다는 문구를 유지해 주세요.",
                  evidenceCandidateIds: ["evidence-candidate-file-upload-001-001"],
                  confidence: 0.91
                }
              ])
            : "[]"
      }))
    };
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
            confidence: 0.97,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    await pipeline.run({ review });

    const calledTasks = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => input.task
    );
    expect(calledTasks).toEqual([
      "creative_review",
      "product_terms",
      "regulation_agent",
      "internal_policy_agent",
      "main_compliance"
    ]);
  });

  it("uses the main compliance lead agent for final risk judgment after conditional quality agents", async () => {
    const provider: ModelProvider = {
      generateText: vi.fn(async ({ task }) => {
        if (task === "creative_review") {
          return {
            provider: "openai",
            model: "gpt-5.2",
            text: JSON.stringify([
              {
                title: "절대 표현과 금리 강조 충돌",
                issueType: "ai_creative_review",
                riskLevel: "high",
                targetText: "누구나 최고 연 5.0%",
                description: "절대 표현과 최고 금리 표현이 함께 있어 소비자 오인 가능성이 큽니다.",
                suggestedAction: "change_request",
                suggestedCopy: "조건 충족 시 최고 연 5.0%로 문구를 조정해 주세요.",
                evidenceCandidateIds: ["evidence-candidate-file-upload-001-001"],
                confidence: 0.88
              }
            ])
          };
        }

        if (task === "product_terms") {
          return {
            provider: "openai",
            model: "gpt-5.2",
            text: JSON.stringify([
              {
                title: "상품자료상 조건 병기됨",
                issueType: "ai_product_terms",
                riskLevel: "info",
                targetText: "우대 조건 충족 시 적용",
                description: "상품자료에는 우대 조건이 확인됩니다.",
                suggestedAction: "hold",
                suggestedCopy: "조건 문구의 위치와 크기를 확인해 주세요.",
                evidenceCandidateIds: ["case-history-evidence-001"],
                confidence: 0.86
              }
            ])
          };
        }

        if (task === "main_compliance") {
          return {
            provider: "openai",
            model: "gpt-5.4",
            text: JSON.stringify([
              {
                title: "팀장 검토: 최고 금리 표현 수정 필요",
                issueType: "ai_main_compliance",
                riskLevel: "reject_recommended",
                targetText: "누구나 최고 연 5.0%",
                description:
                  "홍보물의 절대 표현과 상품자료 조건, 유사 사례를 종합하면 수정 전 승인은 어렵습니다.",
                suggestedAction: "reject",
                suggestedCopy:
                  "조건 충족 시 최고 연 5.0%로 문구를 조정하고 우대 조건을 인접 표시해 주세요.",
                evidenceCandidateIds: [
                  "evidence-candidate-file-upload-001-001",
                  "case-history-evidence-001"
                ],
                confidence: 0.91
              }
            ])
          };
        }

        return {
          provider: "openai",
          model: "gpt-5.2",
          text: "[]"
        };
      })
    };
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      ragRetriever: {
        async retrieve() {
          return [
            {
              id: "evidence-candidate-file-upload-001-001",
              sourceType: "product_doc",
              title: "poster.png",
              quoteSummary: "누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
              relevanceScore: 0.94,
              sourceFileId: "file-upload-001"
            },
            {
              id: "case-history-evidence-001",
              sourceType: "case_history",
              documentId: "rc-2025-014",
              title: "CASE-2025-014",
              quoteSummary: "유사 금리 표현이 조건 고지 위치 문제로 수정 요청되었습니다.",
              relevanceScore: 0.89
            }
          ];
        }
      },
      ocrProvider: {
        async extract(input) {
          return input.files.map((file) => ({
            fileId: file.id,
            fileName: file.name,
            storageKey: file.storageKey,
            text: "누구나 최고 연 5.0% 우대 조건 충족 시 적용됩니다.",
            confidence: 0.93,
            provider: "fixture-ocr"
          }));
        }
      }
    });

    const artifacts = await pipeline.run({ review });

    const calledTasks = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => input.task
    );
    expect(calledTasks).toEqual([
      "creative_review",
      "product_terms",
      "regulation_agent",
      "internal_policy_agent",
      "evidence_verification",
      "case_search",
      "main_compliance"
    ]);
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "case_search",
        routeContext: expect.objectContaining({
          caseStronglyInfluencesJudgment: true
        })
      })
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "main_compliance",
        instructions: expect.stringContaining("FinProof main_compliance agent"),
        routeContext: expect.objectContaining({
          riskLevel: "high"
        })
      })
    );
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "case_search",
        instructions: expect.stringContaining("FinProof case_search agent")
      })
    );
    const mainComplianceInput = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls.find(
      ([input]) => input.task === "main_compliance"
    )?.[0].input;
    expect(JSON.parse(String(mainComplianceInput))).toEqual(
      expect.objectContaining({
        priorFindings: expect.arrayContaining([
          expect.objectContaining({ agent: "creative_review", riskLevel: "high" }),
          expect.objectContaining({ agent: "product_terms", riskLevel: "info" })
        ])
      })
    );
    expect(artifacts.agentFindings).toEqual([
      expect.objectContaining({
        agent: "main",
        riskLevel: "high",
        suggestedAction: "change_request",
        title: "팀장 검토: 최고 금리 표현 수정 필요"
      })
    ]);
  });

  it("integrates English multilingual findings before domain subagents run", async () => {
    const provider = multilingualProviderReturning({
      english_translator_risk: JSON.stringify({
        findings: [
          {
            segmentId: "seg-en-001",
            language: "en",
            originalText: "Guaranteed approval in 3 minutes",
            literalTranslation: "3분 내 승인 보장",
            complianceMeaning: "대출 승인 여부가 확정된 것처럼 표현합니다.",
            riskCategory: "both",
            riskSignals: ["guaranteed approval"],
            riskLevelHint: "high",
            suggestedCopyOriginalLanguage: "Approval may vary after review.",
            suggestedCopyKoreanMeaning: "승인은 심사 후 달라질 수 있습니다.",
            confidence: 0.89
          }
        ]
      }),
      korean_compliance_mapping: JSON.stringify({
        mappings: [
          {
            localizedFindingId: "seg-en-001",
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE",
            koreanComplianceCategory: "대출 승인 보장 표현",
            koreanComplianceReason: "심사 전 승인 확정 표현은 오인 가능성이 큽니다.",
            evidenceQuery: "대출 승인 보장 금융광고",
            suggestedAction: "reject"
          }
        ]
      })
    });
    const subAgentOrchestrator: ReviewSubAgentOrchestrator = {
      run: vi.fn(async () => [])
    };
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator,
      ocrProvider: fixedOcrProvider("Guaranteed approval in 3 minutes")
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.multilingualSegments?.map((segment) => segment.language)).toEqual(["en"]);
    expect(artifacts.localizedRiskFindings?.[0]?.originalText).toBe(
      "Guaranteed approval in 3 minutes"
    );
    expect(subAgentOrchestrator.run).toHaveBeenCalledWith(
      expect.objectContaining({
        priorFindings: expect.arrayContaining([
          expect.objectContaining({
            agent: "korean_compliance_mapping",
            targetText: "Guaranteed approval in 3 minutes",
            riskLevel: "high",
            suggestedAction: "change_request"
          })
        ])
      })
    );
  });

  it("integrates social context KG findings and evidence before domain subagents run", async () => {
    const provider = multilingualProviderReturning({
      english_translator_risk: "[]"
    });
    const subAgentOrchestrator: ReviewSubAgentOrchestrator = {
      run: vi.fn(async ({ priorFindings = [] }) => priorFindings)
    };
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator,
      ocrProvider: fixedOcrProvider("Killing Fields급 수익률 이벤트")
    });
    const socialReview: ReviewCase = {
      ...review,
      id: "rc-social-context-001",
      title: "캄보디아 투자상품 SNS 이벤트",
      affiliate: "PPCBank",
      productType: "investment",
      channelType: ["SNS"],
      plannedPublishDate: "2026-04-17",
      promotionalCopy: "Killing Fields급 수익률 이벤트",
      productDescription: "수익률 이벤트 안내"
    };

    const artifacts = await pipeline.run({ review: socialReview });

    expect(artifacts.socialContextMatches).toEqual([
      expect.objectContaining({
        countryId: "cambodia",
        ruleId: "country_sensitive_date_trauma_metaphor_finance_promo",
        riskLevel: "high",
        suggestedAction: "hold"
      })
    ]);
    expect(artifacts.evidenceCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining("social-context-rule-cambodia"),
          sourceType: "internal_policy"
        })
      ])
    );
    expect(subAgentOrchestrator.run).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceCandidates: expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringContaining("social-context-rule-cambodia")
          })
        ]),
        priorFindings: expect.arrayContaining([
          expect.objectContaining({
            agent: "social_context_review",
            riskLevel: "high",
            suggestedAction: "hold"
          })
        ])
      })
    );
    expect(artifacts.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentType: "social_context",
          issueType: "social_context_kg_risk",
          riskLevel: "high",
          suggestedAction: "hold"
        })
      ])
    );
  });

  it("routes Vietnamese OCR text through the Vietnamese translator risk agent", async () => {
    const provider = multilingualProviderReturning({
      vietnamese_translator_risk: "[]"
    });
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator: emptySubAgentOrchestrator(),
      ocrProvider: fixedOcrProvider("Phê duyệt khoản vay trong 3 phút")
    });

    await pipeline.run({ review });

    expect(provider.calls).toEqual(["vietnamese_translator_risk"]);
  });

  it("routes Myanmar OCR text through the Myanmar translator risk agent", async () => {
    const provider = multilingualProviderReturning({
      myanmar_translator_risk: "[]"
    });
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator: emptySubAgentOrchestrator(),
      ocrProvider: fixedOcrProvider("ချေးငွေ အတည်ပြုချက် ၃ မိနစ်အတွင်း")
    });

    await pipeline.run({ review });

    expect(provider.calls).toEqual(["myanmar_translator_risk"]);
  });

  it("routes Khmer OCR text through the Khmer translator risk agent", async () => {
    const provider = multilingualProviderReturning({
      khmer_translator_risk: "[]"
    });
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator: emptySubAgentOrchestrator(),
      ocrProvider: fixedOcrProvider("អនុម័តប្រាក់កម្ចីក្នុង ៣ នាទី")
    });

    await pipeline.run({ review });

    expect(provider.calls).toEqual(["khmer_translator_risk"]);
  });

  it("routes mixed English Vietnamese Myanmar and Khmer OCR text through all multilingual agents and mapping", async () => {
    const provider = multilingualProviderReturning({
      english_translator_risk: localizedFindingOutput({
        segmentId: "seg-en-001",
        language: "en",
        originalText: "Guaranteed approval in 3 minutes"
      }),
      vietnamese_translator_risk: localizedFindingOutput({
        segmentId: "seg-vi-001",
        language: "vi",
        originalText: "Phê duyệt khoản vay"
      }),
      myanmar_translator_risk: localizedFindingOutput({
        segmentId: "seg-my-001",
        language: "my",
        originalText: "ချေးငွေ အတည်ပြုချက်"
      }),
      khmer_translator_risk: localizedFindingOutput({
        segmentId: "seg-km-001",
        language: "km",
        originalText: "អនុម័តប្រាក់កម្ចី"
      }),
      korean_compliance_mapping: JSON.stringify({
        mappings: [
          {
            localizedFindingId: "seg-en-001",
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE",
            koreanComplianceCategory: "다국어 승인 확정 표현",
            koreanComplianceReason: "심사 전 승인 확정 표현은 오인 가능성이 큽니다.",
            evidenceQuery: "승인 보장 금융광고",
            suggestedAction: "reject"
          },
          {
            localizedFindingId: "seg-vi-001",
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE",
            koreanComplianceCategory: "다국어 승인 표현",
            koreanComplianceReason: "베트남어 문구가 승인 가능성을 단정적으로 전달할 수 있습니다.",
            evidenceQuery: "베트남어 승인 표현 금융광고",
            suggestedAction: "change_request"
          },
          {
            localizedFindingId: "seg-my-001",
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE",
            koreanComplianceCategory: "다국어 승인 표현",
            koreanComplianceReason: "미얀마어 문구가 승인 가능성을 단정적으로 전달할 수 있습니다.",
            evidenceQuery: "미얀마어 승인 표현 금융광고",
            suggestedAction: "change_request"
          },
          {
            localizedFindingId: "seg-km-001",
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE",
            koreanComplianceCategory: "다국어 승인 표현",
            koreanComplianceReason: "크메르어 문구가 승인 가능성을 단정적으로 전달할 수 있습니다.",
            evidenceQuery: "크메르어 승인 표현 금융광고",
            suggestedAction: "change_request"
          }
        ]
      })
    });
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator: emptySubAgentOrchestrator(),
      ocrProvider: fixedOcrProvider(
        "Guaranteed approval in 3 minutes Phê duyệt khoản vay ချေးငွေ အတည်ပြုချက် អនុម័តប្រាក់កម្ចី"
      )
    });

    await pipeline.run({ review });

    expect(provider.calls).toEqual([
      "english_translator_risk",
      "vietnamese_translator_risk",
      "myanmar_translator_risk",
      "khmer_translator_risk",
      "korean_compliance_mapping"
    ]);
  });

  it("skips Japanese and Chinese OCR text because those languages are not supported", async () => {
    const provider = multilingualProviderReturning({});
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator: emptySubAgentOrchestrator(),
      ocrProvider: fixedOcrProvider("最短3分で審査完了 最低利率 无需审核")
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.multilingualSegments).toBeUndefined();
    expect(provider.calls).toEqual([]);
  });

  it("keeps Korean-only OCR unchanged and skips multilingual model tasks", async () => {
    const provider = multilingualProviderReturning({});
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator: emptySubAgentOrchestrator(),
      ocrProvider: fixedOcrProvider("최고 연 5.0% 우대금리는 급여이체 조건 충족 시 제공됩니다.")
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.multilingualSegments).toBeUndefined();
    expect(provider.calls).not.toEqual(
      expect.arrayContaining([
        "english_translator_risk",
        "vietnamese_translator_risk",
        "myanmar_translator_risk",
        "khmer_translator_risk",
        "korean_compliance_mapping"
      ])
    );
  });

  it("preserves multilingual source agent context when issues convert to finding candidates", async () => {
    const provider = multilingualProviderReturning({
      english_translator_risk: JSON.stringify({
        findings: [
          {
            segmentId: "seg-en-001",
            language: "en",
            originalText: "Guaranteed approval in 3 minutes",
            literalTranslation: "3분 내 승인 보장",
            complianceMeaning: "대출 승인 여부가 확정된 것처럼 표현합니다.",
            riskCategory: "both",
            riskSignals: ["guaranteed approval"],
            riskLevelHint: "high",
            suggestedCopyOriginalLanguage: "Approval may vary after review.",
            suggestedCopyKoreanMeaning: "승인은 심사 후 달라질 수 있습니다.",
            confidence: 0.81
          }
        ]
      }),
      korean_compliance_mapping: JSON.stringify({
        mappings: [
          {
            localizedFindingId: "seg-en-001",
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE",
            koreanComplianceCategory: "대출 승인 보장 표현",
            koreanComplianceReason: "심사 전 승인 확정 표현은 오인 가능성이 큽니다.",
            evidenceQuery: "대출 승인 보장 금융광고",
            suggestedAction: "change_request"
          }
        ]
      })
    });
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      subAgentOrchestrator: passthroughPriorFindingOrchestrator(),
      ocrProvider: fixedOcrProvider("Guaranteed approval in 3 minutes")
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.findings?.[0]).toMatchObject({
      agentType: "korean_compliance_mapping",
      targetText: "Guaranteed approval in 3 minutes",
      localizedRiskFinding: {
        originalText: "Guaranteed approval in 3 minutes"
      },
      koreanComplianceMapping: {
        issueType: "MULTILINGUAL_APPROVAL_GUARANTEE"
      }
    });
  });

  it("keeps multilingual prior findings when the real orchestrator returns main findings", async () => {
    const provider = multilingualProviderReturning({
      english_translator_risk: JSON.stringify({
        findings: [
          {
            segmentId: "seg-en-001",
            language: "en",
            originalText: "Guaranteed approval in 3 minutes",
            literalTranslation: "3분 내 승인 보장",
            complianceMeaning: "대출 승인 여부가 확정된 것처럼 표현합니다.",
            riskCategory: "both",
            riskSignals: ["guaranteed approval"],
            riskLevelHint: "high",
            suggestedCopyOriginalLanguage: "Approval may vary after review.",
            suggestedCopyKoreanMeaning: "승인은 심사 후 달라질 수 있습니다.",
            confidence: 0.88
          }
        ]
      }),
      korean_compliance_mapping: JSON.stringify({
        mappings: [
          {
            localizedFindingId: "seg-en-001",
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE",
            koreanComplianceCategory: "대출 승인 보장 표현",
            koreanComplianceReason: "심사 전 승인 확정 표현은 오인 가능성이 큽니다.",
            evidenceQuery: "guaranteed approval",
            suggestedAction: "change_request"
          }
        ]
      }),
      main_compliance: JSON.stringify([
        {
          title: "팀장 검토: 승인 보장 표현 수정 필요",
          issueType: "ai_main_compliance",
          riskLevel: "high",
          targetText: "Guaranteed approval in 3 minutes",
          description: "대출 승인 보장 표현은 심사 조건을 오인시킬 수 있습니다.",
          suggestedAction: "change_request",
          suggestedCopy: "Approval is subject to review.",
          evidenceCandidateIds: ["evidence-candidate-file-upload-001-001"],
          confidence: 0.9
        }
      ])
    });
    const pipeline = createReviewAnalysisPipeline({
      modelProvider: provider,
      ocrProvider: fixedOcrProvider("Guaranteed approval in 3 minutes")
    });

    const artifacts = await pipeline.run({ review });

    expect(artifacts.agentFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "korean_compliance_mapping",
          localizedRiskFinding: expect.objectContaining({
            originalText: "Guaranteed approval in 3 minutes"
          }),
          koreanComplianceMapping: expect.objectContaining({
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE"
          })
        }),
        expect.objectContaining({
          agent: "main",
          title: "팀장 검토: 승인 보장 표현 수정 필요"
        })
      ])
    );
    expect(artifacts.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentType: "korean_compliance_mapping",
          localizedRiskFinding: expect.objectContaining({
            originalText: "Guaranteed approval in 3 minutes"
          }),
          koreanComplianceMapping: expect.objectContaining({
            issueType: "MULTILINGUAL_APPROVAL_GUARANTEE"
          })
        })
      ])
    );
  });
});

function fixedOcrProvider(text: string) {
  return {
    async extract(input: { files: typeof review.files }) {
      return input.files.map((file) => ({
        fileId: file.id,
        fileName: file.name,
        storageKey: file.storageKey,
        text,
        confidence: 0.94,
        provider: "fixture-ocr"
      }));
    }
  };
}

function emptySubAgentOrchestrator(): ReviewSubAgentOrchestrator {
  return {
    run: vi.fn(async () => [])
  };
}

function passthroughPriorFindingOrchestrator(): ReviewSubAgentOrchestrator {
  return {
    run: vi.fn(async ({ priorFindings = [] }) => priorFindings)
  };
}

function multilingualProviderReturning(
  outputs: Record<string, string | Error>
): ModelProvider & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    generateText: vi.fn(async ({ task }) => {
      calls.push(String(task));
      const output = outputs[String(task)] ?? "[]";

      if (output instanceof Error) {
        throw output;
      }

      return {
        provider: "deterministic",
        model: "fixture",
        text: output
      };
    })
  };
}

function localizedFindingOutput({
  segmentId,
  language,
  originalText
}: {
  segmentId: string;
  language: "en" | "vi" | "my" | "km";
  originalText: string;
}) {
  return JSON.stringify({
    findings: [
      {
        segmentId,
        language,
        originalText,
        literalTranslation: "번역 문구",
        complianceMeaning: "외국어 금융 광고 표현에 오인 가능성이 있습니다.",
        riskCategory: "both",
        riskSignals: ["approval"],
        riskLevelHint: "high",
        suggestedCopyOriginalLanguage: "Review conditions apply.",
        suggestedCopyKoreanMeaning: "조건에 따라 달라질 수 있습니다.",
        confidence: 0.86
      }
    ]
  });
}

function ragCandidate(overrides: Partial<RagEvidenceCandidate>): RagEvidenceCandidate {
  return {
    id: "candidate",
    sourceType: "product_doc",
    title: "제목",
    quoteSummary: "요약",
    relevanceScore: 0.7,
    ...overrides
  };
}

describe("selectEvidenceCandidates", () => {
  it("drops candidates below the matching threshold (preserves 9800ef8 behavior)", () => {
    const candidates: RagEvidenceCandidate[] = [
      ragCandidate({ id: "product-high", sourceType: "product_doc", relevanceScore: 0.7 }),
      ragCandidate({
        id: "knowledge-low",
        sourceType: "internal_policy",
        relevanceScore: 0.03
      })
    ];

    const selected = selectEvidenceCandidates(candidates, { minScore: 0.55, topK: 4 });

    expect(selected.map((candidate) => candidate.id)).not.toContain("knowledge-low");
  });

  it("guarantees above-threshold knowledge evidence is not crowded out by product docs", () => {
    // Uploaded package documents lexically overlap the ad copy and dominate the rerank,
    // filling every topK slot. Knowledge-corpus evidence (the regulatory basis) must
    // still earn a slot rather than being sliced out.
    const candidates: RagEvidenceCandidate[] = [
      ragCandidate({ id: "product-1", sourceType: "product_doc", relevanceScore: 0.76 }),
      ragCandidate({ id: "product-2", sourceType: "product_doc", relevanceScore: 0.75 }),
      ragCandidate({ id: "product-3", sourceType: "product_doc", relevanceScore: 0.73 }),
      ragCandidate({ id: "product-4", sourceType: "product_doc", relevanceScore: 0.72 }),
      ragCandidate({ id: "knowledge-1", sourceType: "internal_policy", relevanceScore: 0.6 }),
      ragCandidate({ id: "law-1", sourceType: "law", relevanceScore: 0.58 })
    ];

    const selected = selectEvidenceCandidates(candidates, { minScore: 0.55, topK: 4 });

    expect(selected).toHaveLength(4);
    const knowledgeIds = selected
      .filter(
        (candidate) => candidate.sourceType === "internal_policy" || candidate.sourceType === "law"
      )
      .map((candidate) => candidate.id);
    expect(knowledgeIds.length).toBeGreaterThanOrEqual(1);
  });

  it("does not reserve knowledge slots when no knowledge candidates exist", () => {
    const candidates: RagEvidenceCandidate[] = [
      ragCandidate({ id: "product-1", sourceType: "product_doc", relevanceScore: 0.76 }),
      ragCandidate({ id: "product-2", sourceType: "product_doc", relevanceScore: 0.72 })
    ];

    const selected = selectEvidenceCandidates(candidates, { minScore: 0.55, topK: 4 });

    expect(selected.map((candidate) => candidate.id)).toEqual(["product-1", "product-2"]);
  });
});

describe("Phase 2 — python service OCR provider", () => {
  const pythonEnv = {
    FINPROOF_OCR_PROVIDER: "python_service",
    FINPROOF_OCR_ENDPOINT: "http://localhost:8000"
  };

  it("routes an image file to the python service and uses its result", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "연 10% 확정 수익 보장", confidence: 0.83, provider: "tesseract" })
    }));
    const provider = createPythonServiceOcrProvider(
      pythonEnv,
      {
        async getReviewFileBody() {
          return new TextEncoder().encode("PNGBYTES");
        }
      },
      fetchImpl
    );

    const [document] = await provider.extract({ review, files: review.files });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(document.provider).toBe("tesseract");
    expect(document.text).toContain("확정 수익");
    expect(document.confidence).toBe(0.83);
  });

  it("routes via the canonical `http` value (python_service alias preserved)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        text: "월 최대 300만원 즉시 대출",
        confidence: 0.79,
        provider: "tesseract"
      })
    }));
    const provider = createPythonServiceOcrProvider(
      { FINPROOF_OCR_PROVIDER: "http", FINPROOF_OCR_ENDPOINT: "http://localhost:8000" },
      {
        async getReviewFileBody() {
          return new TextEncoder().encode("PNGBYTES");
        }
      },
      fetchImpl
    );

    const [document] = await provider.extract({ review, files: review.files });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(document.provider).toBe("tesseract");
    expect(document.confidence).toBe(0.79); // low-confidence OCR signal preserved (< 0.82)
  });

  it("falls back to metadata extraction when the service is unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = createPythonServiceOcrProvider(
      pythonEnv,
      {
        async getReviewFileBody() {
          return new TextEncoder().encode("PNGBYTES");
        }
      },
      fetchImpl
    );

    const [document] = await provider.extract({ review, files: review.files });

    expect(document.provider).toBe("metadata-only"); // legacy fallback preserved
  });

  it("does not call the service when not enabled (legacy behavior)", async () => {
    const fetchImpl = vi.fn();
    const provider = createPythonServiceOcrProvider(
      {},
      {
        async getReviewFileBody() {
          return new TextEncoder().encode("PNGBYTES");
        }
      },
      fetchImpl
    );

    const [document] = await provider.extract({ review, files: review.files });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.provider).toBe("metadata-only");
  });
});

describe("Phase 3 — content-based hybrid OCR provider", () => {
  // The PDF text-layer probe (`pdftotext`) is injected in these tests so routing is
  // deterministic without the poppler binary (CI runners don't have it). A non-empty
  // (>40 non-whitespace chars) probe => digital PDF; `undefined` => scanned PDF.
  const PDF_BODY = new Uint8Array([37, 80, 68, 70]); // "%PDF"
  const DIGITAL_TEXT =
    "디지털PDF텍스트레이어상품설명서금리연4.9퍼센트최대한도8000만원표보존테스트본문";
  const digitalProbe = async () => DIGITAL_TEXT;
  const scannedProbe = async () => undefined;

  const hybridEnv = {
    FINPROOF_OCR_PROVIDER: "hybrid",
    FINPROOF_OCR_ENDPOINT: "http://localhost:8000",
    OPENAI_API_KEY: "test-key"
  };

  function makeFile(over: Partial<(typeof review.files)[number]>) {
    return {
      id: "file-h",
      name: "doc",
      fileType: "promotional_creative" as const,
      classificationConfidence: 0.8,
      parseStatus: "pending" as const,
      storageProvider: "s3" as const,
      storageKey: "s3://b/doc",
      contentType: "application/octet-stream",
      sizeBytes: 1024,
      ...over
    };
  }

  function reader(body: Uint8Array) {
    return {
      async getReviewFileBody() {
        return body;
      }
    };
  }

  const visionFetch = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ output_text: "비전 OCR 추출: 최저 연 4.9% 연체 최고 15%" })
    }));
  const serviceFetch = (provider: string) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "서비스 추출 본문", confidence: 0.95, provider })
    }));

  it("routes an image to the vision LLM (not the Python service)", async () => {
    const vision = visionFetch();
    const service = serviceFetch("pdfplumber");
    const provider = createHybridOcrProvider(
      hybridEnv,
      reader(new Uint8Array([1, 2, 3])),
      vision,
      service
    );

    const files = [makeFile({ name: "banner.png", contentType: "image/png" })];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(vision).toHaveBeenCalledOnce();
    expect(service).not.toHaveBeenCalled();
    expect(document.provider).toBe("openai-ocr");
    expect(document.text).toContain("연체 최고 15%");
  });

  it("routes a digital (text-layer) PDF to the Python service (not the vision LLM)", async () => {
    const vision = visionFetch();
    const service = serviceFetch("pdfplumber");
    const provider = createHybridOcrProvider(
      hybridEnv,
      reader(PDF_BODY),
      vision,
      service,
      digitalProbe
    );

    const files = [makeFile({ name: "rates.pdf", contentType: "application/pdf" })];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(service).toHaveBeenCalledOnce();
    expect(vision).not.toHaveBeenCalled();
    expect(document.provider).toBe("pdfplumber");
  });

  it("keeps the local text layer when the service is unreachable for a digital PDF", async () => {
    const vision = visionFetch();
    const provider = createHybridOcrProvider(
      { FINPROOF_OCR_PROVIDER: "hybrid", OPENAI_API_KEY: "test-key" }, // no FINPROOF_OCR_ENDPOINT
      reader(PDF_BODY),
      vision,
      undefined,
      digitalProbe
    );

    const files = [makeFile({ name: "rates.pdf", contentType: "application/pdf" })];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(vision).not.toHaveBeenCalled();
    expect(document.provider).toBe("local-pdf-text-extractor");
    expect(document.text).toContain("텍스트레이어");
  });

  it("routes a scanned PDF (no text layer) to the vision LLM", async () => {
    const vision = visionFetch();
    const service = serviceFetch("pdfplumber");
    const provider = createHybridOcrProvider(
      hybridEnv,
      reader(PDF_BODY),
      vision,
      service,
      scannedProbe
    );

    const files = [makeFile({ name: "scan.pdf", contentType: "application/pdf" })];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(vision).toHaveBeenCalledOnce();
    expect(service).not.toHaveBeenCalled();
    expect(document.provider).toBe("openai-ocr");
  });

  it("routes a DOCX to the Python service", async () => {
    const vision = visionFetch();
    const service = serviceFetch("python-docx");
    const provider = createHybridOcrProvider(
      hybridEnv,
      reader(new Uint8Array([80, 75])),
      vision,
      service
    );

    const files = [
      makeFile({
        name: "terms.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(service).toHaveBeenCalledOnce();
    expect(vision).not.toHaveBeenCalled();
    expect(document.provider).toBe("python-docx");
  });

  it("extracts text files locally without any external call", async () => {
    const vision = visionFetch();
    const service = serviceFetch("pdfplumber");
    const provider = createHybridOcrProvider(
      hybridEnv,
      reader(new TextEncoder().encode("일반 텍스트 광고 문안 본문")),
      vision,
      service
    );

    const files = [makeFile({ name: "copy.txt", contentType: "text/plain" })];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(vision).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
    expect(document.provider).toBe("local-text-extractor");
    expect(document.text).toContain("광고 문안");
  });

  it("falls back to metadata when the vision call fails (analysis never breaks)", async () => {
    const vision = vi.fn(async () => {
      throw new Error("OpenAI 5xx");
    });
    const provider = createHybridOcrProvider(hybridEnv, reader(new Uint8Array([1, 2, 3])), vision);

    const files = [makeFile({ name: "banner.png", contentType: "image/png" })];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(vision).toHaveBeenCalledOnce();
    expect(document.provider).toBe("metadata-only"); // legacy fallback preserved
  });

  it("falls back to metadata for an image when OPENAI_API_KEY is missing", async () => {
    const vision = visionFetch();
    const provider = createHybridOcrProvider(
      { FINPROOF_OCR_PROVIDER: "hybrid", FINPROOF_OCR_ENDPOINT: "http://localhost:8000" },
      reader(new Uint8Array([1, 2, 3])),
      vision
    );

    const files = [makeFile({ name: "banner.png", contentType: "image/png" })];
    const [document] = await provider.extract({ review: { ...review, files }, files });

    expect(vision).not.toHaveBeenCalled();
    expect(document.provider).toBe("metadata-only");
  });
});
