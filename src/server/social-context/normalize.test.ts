import { findAliasMatch, normalizeSocialContextText } from "./normalize";

describe("social context normalization", () => {
  it("normalizes width, case, punctuation, and whitespace", () => {
    expect(normalizeSocialContextText(" Ｔａｎｋ   Man!!!  혜택 ")).toBe("tank man! 혜택");
  });

  it("matches Latin aliases on token boundaries and non-Latin aliases by script", () => {
    expect(findAliasMatch("Tank Man급 금리 이벤트", "Tank Man")).toBe("Tank Man");
    expect(findAliasMatch("banking 혜택", "king")).toBeUndefined();
    expect(findAliasMatch("대만 국기를 국가 목록에 표시", "대만")).toBe("대만");
  });
});
