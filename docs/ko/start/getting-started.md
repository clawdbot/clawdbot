---
summary: "OpenClaw를 설치하고 몇 분 안에 첫 채팅을 시작하세요."
read_when:
  - 처음부터 설정하기
  - 작동하는 채팅까지 가장 빠른 경로
title: "시작하기"
---

OpenClaw를 설치하고 온보딩을 실행하여 AI 어시스턴트와 채팅하는 데 약 5분이
걸립니다. 완료하면 실행 중인 게이트웨이, 구성된 인증 및 작동하는 채팅 세션을
갖게 됩니다.

## 필요한 것

- **Node.js 22.22.3+, 24.15+, 또는 25.9+** (Node 26이 권장 런타임입니다)
- **모델 제공자의 API 키** (Anthropic, OpenAI, Google 등) — 온보딩에서 요청합니다

<Tip>
Node 버전은 `node --version`으로 확인하세요.
**Windows 사용자:** 네이티브 Windows Hub 앱이 가장 쉬운 데스크톱 경로입니다.
PowerShell 설치 프로그램 및 WSL2 게이트웨이 경로도 지원됩니다. [Windows](/platforms/windows)를 참조하세요.
Node를 설치해야 하나요? [Node 설정](/install/node)을 참조하세요.
</Tip>

## 빠른 설정

<Steps>
  <Step title="OpenClaw 설치">
    <Tabs>
      <Tab title="macOS / Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Install Script Process"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    기타 설치 방법 (Docker, Nix, npm): [설치](/install).
    </Note>

  </Step>
  <Step title="온보딩 실행">
    ```bash
    openclaw onboard --install-daemon
    ```

    마법사가 모델 제공자 선택, API 키 설정, 게이트웨이 구성을 안내합니다.
    빠른 시작은 보통 몇 분이면 되지만, 제공자 로그인, 채널 페어링, 데몬 설치,
    네트워크 다운로드, 스킬 또는 선택적 플러그인으로 인해 전체 온보딩에
    시간이 더 걸릴 수 있습니다. 선택 단계는 건너뛰고 나중에
    `openclaw configure`로 돌아올 수 있습니다.

    전체 참조는 [온보딩 (CLI)](/start/wizard)를 참조하세요.

  </Step>
  <Step title="게이트웨이가 실행 중인지 확인">
    ```bash
    openclaw gateway status
    ```

    게이트웨이가 포트 18789에서 수신 중인지 확인합니다.

  </Step>
  <Step title="대시보드 열기">
    ```bash
    openclaw dashboard
    ```

    브라우저에서 컨트롤 UI가 열립니다. 로드되면 모든 것이 작동하는 것입니다.

  </Step>
  <Step title="첫 번째 메시지 보내기">
    컨트롤 UI 채팅에 메시지를 입력하면 AI 응답을 받습니다.

    휴대폰에서 채팅하고 싶으신가요? 가장 빠르게 설정할 수 있는 채널은
    [Telegram](/channels/telegram)입니다 (봇 토큰만 있으면 됩니다).
    모든 옵션은 [채널](/channels)을 참조하세요.

  </Step>
</Steps>

<Accordion title="고급: 커스텀 컨트롤 UI 빌드 마운트">
현지화되거나 커스터마이즈된 대시보드 빌드를 유지하는 경우,
`gateway.controlUi.root`를 빌드된 정적 자산과 `index.html`이 포함된
디렉토리로 설정하세요.

```bash
mkdir -p "$HOME/.openclaw/control-ui-custom"
# 빌드된 정적 파일을 해당 디렉토리에 복사하세요.
```

그런 다음 설정:

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true,
      "root": "${HOME}/.openclaw/control-ui-custom"
    }
  }
}
```

게이트웨이를 재시작하고 대시보드를 다시 여세요:

```bash
openclaw gateway restart
openclaw dashboard
```

</Accordion>

## 다음에 할 일

<Columns>
  <Card title="채널 연결" href="/channels" icon="message-square">
    Discord, Feishu, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo 등.
  </Card>
  <Card title="페어링 및 안전" href="/channels/pairing" icon="shield">
    누가 에이전트와 메시지를 주고받을 수 있는지 제어하세요.
  </Card>
  <Card title="게이트웨이 구성" href="/gateway/configuration" icon="settings">
    모델, 도구, 샌드박스 및 고급 설정.
  </Card>
  <Card title="도구 탐색" href="/tools" icon="wrench">
    브라우저, exec, 웹 검색, 스킬 및 플러그인.
  </Card>
</Columns>

<Accordion title="고급: 환경 변수">
서비스 계정으로 OpenClaw를 실행하거나 커스텀 경로를 사용하려는 경우:

- `OPENCLAW_HOME` — 내부 경로 해석을 위한 홈 디렉토리
- `OPENCLAW_STATE_DIR` — 상태 디렉토리 재정의
- `OPENCLAW_CONFIG_PATH` — 구성 파일 경로 재정의

전체 참조: [환경 변수](/help/environment).
</Accordion>

## 관련

- [설치 개요](/install)
- [채널 개요](/channels)
- [설정](/start/setup)