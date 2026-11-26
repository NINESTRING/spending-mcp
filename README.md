# spending-mcp

카드 명세서를 AI 어시스턴트에게 주면 정리해서 DB에 쌓아 두고, 언제든 "이번 달 지출 분석해 줘"라고 물어볼 수 있게 해 주는 개인 지출 관리 **MCP 서버**입니다.

NestJS와 [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview)로 만들었고, 구조는 [NestJS MCP 서버 튜토리얼](https://docs.nestjs.com/tutorials/mcp-server)을 따릅니다.

## 동작 방식

```
카드 명세서 (PDF · 엑셀 · 캡처 · 텍스트)
        │
        ▼
  AI 어시스턴트 (Claude)  ── 날짜·가맹점·금액·카테고리로 구조화
        │  MCP
        ▼
  spending-mcp (NestJS)   ── 검증, 중복 제거, 집계
        │
        ▼
     PostgreSQL
```

- 명세서를 읽고 구조화하는 일은 AI가 합니다.
- 저장, 중복 제거, 합계와 전월 비교는 서버가 SQL로 합니다. AI가 수백 건을 직접 더하지 않으므로 숫자가 틀리지 않습니다.

## 제공하는 기능

| 이름 | 종류 | 역할 |
| --- | --- | --- |
| `import-transactions` | Tool (쓰기) | 명세서 거래를 한 번에 최대 200건 저장 |
| `search-transactions` | Tool (읽기) | 기간·가맹점·카테고리로 거래 조회 |
| `summarize-spending` | Tool (읽기) | 한 달 총액, 카테고리별 합계, 지출 상위 가맹점 10곳 |
| `compare-months` | Tool (읽기) | 두 달을 카테고리별로 비교 (기본은 전월) |
| `set-merchant-category` | Tool (쓰기) | 가맹점 카테고리를 바꾸고 과거 거래에도 반영 |
| `analyze-month` | Prompt | 월간 분석 리포트 형식 |

## 설계에서 신경 쓴 점

- **다시 넣어도 중복되지 않습니다.** 거래마다 사용자별 유니크 키를 만들어, 같은 명세서를 두 번 올려도 한 번만 저장됩니다. 같은 날 같은 가게에서 같은 금액을 두 번 쓴 경우는 명세서 안의 순번으로 구분해 두 건으로 저장합니다.
- **가맹점의 카테고리가 달마다 바뀌지 않습니다.** 가맹점은 처음 분류된 카테고리를 계속 유지합니다. AI가 이번에는 다르게 분류해도 서버가 기존 값으로 맞추고, 바꾼 내역을 결과로 알려 줍니다.
- **카테고리는 12개로 고정입니다.** 목록이 고정이어야 월별 비교가 의미가 있습니다. [`src/spending/categories.ts`](src/spending/categories.ts)에서 바꿀 수 있습니다.
- **모든 쿼리는 사용자 단위로 격리됩니다.** 사용자 조건은 조회 후 검사가 아니라 SQL의 `WHERE` 절에 들어갑니다. AI가 어떤 인자를 넘기든 다른 사용자의 데이터에는 닿지 않습니다.
- **카드 번호 전체는 저장하지 않습니다.** 카드는 "신한 1234"처럼 카드사와 끝 4자리 라벨로만 받습니다.
- **금액은 원화 정수입니다.** 취소와 환불은 음수로 저장되어 합계에서 자동으로 빠집니다.

## 연결 방식

| 방식 | 실행 | 인증 | 사용자 식별 |
| --- | --- | --- | --- |
| stdio | `node dist/stdio.js` | 없음 (로컬 프로세스) | 환경변수 `SPENDING_OWNER` |
| HTTP | `POST /mcp` | OAuth 2.1 액세스 토큰 (JWT) | 토큰의 `sub` |

HTTP에서 읽기는 `spending:read`, 쓰기 Tool은 `spending:write` 스코프가 필요합니다.

## 시작하기

Node.js 22.18 이상과 Docker가 필요합니다.

```bash
pnpm install
cp .env.example .env
docker compose up -d      # PostgreSQL 17
pnpm db:migrate
pnpm build
```

### Claude Code에 연결

```bash
claude mcp add spending --env SPENDING_OWNER=me -- node /절대/경로/spending-mcp/dist/stdio.js
```

`SPENDING_OWNER`는 데이터 주인을 구분하는 이름입니다(영문 소문자, 숫자, `-`). 등록 후 새 세션에서 다음처럼 씁니다.

- "이 카드 명세서 저장해 줘" (파일이나 텍스트 첨부)
- "이번 달 지출 분석해 줘"
- "지난달보다 뭘 더 썼어?"
- "쿠팡은 생활 카테고리로 바꿔 줘"

### 다른 MCP 클라이언트

`mcpServers` 설정을 쓰는 클라이언트(Claude Desktop, Cursor 등)는 다음과 같이 등록합니다.

```json
{
  "mcpServers": {
    "spending": {
      "command": "node",
      "args": ["/절대/경로/spending-mcp/dist/stdio.js"],
      "env": { "SPENDING_OWNER": "me" }
    }
  }
}
```

## 프로젝트 구조

```
src/
├── main.ts                  HTTP 진입점
├── stdio.ts                 stdio 진입점
├── app.module.ts            설정, DB, MCP 모듈 조립
├── config.ts                환경변수 스키마 (Zod)
├── auth/                    JWT 액세스 토큰 검증
├── database/schema.ts       테이블 정의 (Drizzle)
└── spending/
    ├── spending.tools.ts    Tool과 Prompt 정의
    ├── spending.service.ts  저장, 조회, 집계 쿼리
    ├── owner.decorator.ts   호출한 사용자 식별
    └── categories.ts        카테고리 목록
```

스키마를 바꾼 뒤에는 마이그레이션을 만들고 적용합니다.

```bash
pnpm db:generate --name=변경-내용
pnpm db:migrate
```

## 기술 스택

NestJS 12 · `@nestjs/mcp` · MCP TypeScript SDK · PostgreSQL 17 · Drizzle ORM · Zod

## 현재 상태

- [x] stdio 연결로 저장·중복 방지·월별 집계·전월 비교·카테고리 변경 동작 확인
- [x] HTTP 엔드포인트가 토큰 없는 요청을 401로 거절
- [ ] 개발용 토큰 발급 스크립트와, 유효한 토큰으로의 HTTP 호출 검증
- [ ] 자동화 테스트 (인메모리 MCP 클라이언트, HTTP, stdio)
- [ ] 배포
