/** The only categories a transaction can have: a fixed list keeps one month comparable with another. */
export const CATEGORIES = [
  '식비',
  '카페·간식',
  '교통',
  '쇼핑',
  '생활',
  '주거·통신',
  '의료',
  '문화·여가',
  '교육',
  '구독',
  '여행',
  '기타',
] as const;

export type Category = (typeof CATEGORIES)[number];
