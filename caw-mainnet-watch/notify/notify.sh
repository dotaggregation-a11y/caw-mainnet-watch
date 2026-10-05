#!/usr/bin/env bash
# 通知の共通送信口（GitHub Actions 用）。設定されている宛先すべてに送る。
#   echo "本文" | notify/notify.sh "件名"
#
# 宛先ごとの環境変数（設定したものだけ使われる。Secrets に登録する）:
#   DISCORD_WEBHOOK                   Discord の Webhook URL
#   SLACK_WEBHOOK                     Slack の Incoming Webhook URL
#   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
#   LINE_CHANNEL_TOKEN + LINE_TO      LINE Messaging API（LINE Notify は 2025/3 に終了済み）
#   NTFY_TOPIC                        ntfy.sh のトピック名（アプリで購読するとスマホにプッシュ）
#   NTFY_URL                          自前 ntfy サーバーの場合（既定 https://ntfy.sh）
#   GITHUB_ISSUE=1 + GH_TOKEN         この監視リポジトリに Issue を作る（GitHub がメール/アプリで通知）
set -u
TITLE="${1:-CAW watch}"
BODY="$(cat)"
TEXT="$TITLE
$BODY"
SHORT="${TEXT:0:1900}"   # Discord の上限 2000 文字に合わせて切る
sent=0
post() { curl -sS -m 20 -o /dev/null -w "%{http_code}" "$@"; }
ok() { case "$1" in 2??) sent=$((sent+1)); echo "  → $2 ok";; *) echo "  → $2 failed ($1)" >&2;; esac; }

if [ -n "${DISCORD_WEBHOOK:-}" ]; then
  ok "$(jq -n --arg c "$SHORT" '{content:$c}' | post -X POST -H 'Content-Type: application/json' -d @- "$DISCORD_WEBHOOK")" discord
fi
if [ -n "${SLACK_WEBHOOK:-}" ]; then
  ok "$(jq -n --arg t "$TEXT" '{text:$t}' | post -X POST -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK")" slack
fi
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  ok "$(jq -n --arg c "$TELEGRAM_CHAT_ID" --arg t "${TEXT:0:4000}" '{chat_id:$c,text:$t,disable_web_page_preview:true}' \
    | post -X POST -H 'Content-Type: application/json' -d @- "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage")" telegram
fi
if [ -n "${LINE_CHANNEL_TOKEN:-}" ] && [ -n "${LINE_TO:-}" ]; then
  ok "$(jq -n --arg to "$LINE_TO" --arg t "${TEXT:0:4900}" '{to:$to,messages:[{type:"text",text:$t}]}' \
    | post -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $LINE_CHANNEL_TOKEN" -d @- https://api.line.me/v2/bot/message/push)" line
fi
if [ -n "${NTFY_TOPIC:-}" ]; then
  PRIO=3; case "$TITLE" in *🚨*) PRIO=5;; esac   # 5=urgent（マナーモードでも鳴らせる）
  # 日本語タイトルはヘッダだと化けるので JSON 形式で送る
  ok "$(jq -n --arg tp "$NTFY_TOPIC" --arg ti "$TITLE" --arg m "$BODY" --argjson p $PRIO '{topic:$tp,title:$ti,message:$m,priority:$p}' \
    | post -X POST -H 'Content-Type: application/json' -d @- "${NTFY_URL:-https://ntfy.sh}")" ntfy
fi
if [ "${GITHUB_ISSUE:-}" = "1" ] && [ -n "${GH_TOKEN:-}" ]; then
  printf '```\n%s\n```\n' "$BODY" > /tmp/issue-body.md
  if gh issue create -R "$GITHUB_REPOSITORY" --title "$TITLE" --body-file /tmp/issue-body.md >/dev/null; then ok 201 github-issue; else ok 000 github-issue; fi
fi
[ "$sent" -gt 0 ] || echo "::warning::通知先が1つも設定されていない、または全て失敗"
