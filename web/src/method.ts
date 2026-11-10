import type { Data } from "./data";

export function renderMethod(root: HTMLElement, data: Data) {
  const t = data.meta.thresholds, c = data.meta.counts, p = data.meta.period;
  const pats = data.patterns.map((x) => `<li><b>${x.name}</b> (${x.n}개 동) — ${x.desc}</li>`).join("");
  root.innerHTML = `
  <article class="method">
    <h2>방법과 한계</h2>
    <p class="lead">이 사이트의 숫자가 무엇을 뜻하고, 무엇을 뜻하지 않는지 적었습니다. 전체 산식은 저장소의 <code>docs/methodology.md</code>에 있습니다.</p>

    <h3>1. 무엇을 쟀나</h3>
    <ul>
      <li>서울시 도시데이터 센서(S-DoT) 환경정보의 <b>1시간 단위 소음 평균·최대와 조도 평균</b>을 씁니다. 센서는 전봇대·건물 외벽 등 <b>길가</b>에 있습니다.</li>
      <li>그래서 이 값은 <b>동네 바깥 환경</b>입니다. 창문을 닫은 집 안 소음이나 층간소음 측정값이 아닙니다.</li>
      <li>S-DoT는 <b>간이측정기</b>(성능인증 1등급)입니다. 법정 소음 측정이 아니라 동네끼리 견주는 <b>비교용 지표</b>로 봐 주세요.</li>
      <li>센서가 잴 수 있는 가장 작은 값은 ${t.noise_floor}dB입니다. ${t.noise_floor}dB로 나온 곳은 실제로 더 조용할 수 있습니다.</li>
      <li>이번 기간: <b>${p.start} ~ ${p.end}</b> 밤 ${p.nights}개. 센서 ${c.sensors_total}개 중 ${c.sensors_used}개를 동네 대표값에 썼습니다.</li>
    </ul>

    <h3>2. 밤 소음 계산</h3>
    <ul>
      <li>밤 = 22:00~06:00 (KST). 데이터의 측정시간 표기(예: 07:07)는 그 앞 1시간 구간이 끝난 시각으로 보고 1시간을 당겨 씁니다(조도의 해 뜨고 지는 시각으로 확인).</li>
      <li>시간 값들을 <b>에너지 평균</b>으로 합칩니다: L<sub>night</sub> = 10·log<sub>10</sub>(평균(10<sup>L/10</sup>)). 큰 소리가 짧게 나도 평균에 제대로 반영됩니다.</li>
      <li>명세서에 S-DoT 1시간 "평균"을 어떻게 구했는지 나와 있지 않아 <b>산술평균으로 가정</b>했습니다.</li>
      <li>행정동 값 = 그 동 안 <b>주거지역 센서</b>들의 L<sub>night</sub> <b>중앙값</b>. 주거지역 센서가 없으면 공원·도로변을 뺀 다른 센서를 쓰고 그렇다고 표시합니다. 센서가 없는 동은 <b>"데이터 없음"</b>으로 두고 보간하지 않습니다.</li>
    </ul>

    <h3>3. 판단 기준선</h3>
    <ul>
      <li>WHO 야간 목표: 집 밖 연평균 ${t.who_target}dB · WHO 도로교통 야간 권고: ${t.who_road}dB · WHO 중간 목표: ${t.who_interim}dB.</li>
      <li>WHO 기준은 <b>1년 평균</b>입니다. 이 사이트의 기간은 아직 ${p.nights}일이라 계절에 따라 달라질 수 있습니다.</li>
    </ul>

    <h3>4. 보조 지표</h3>
    <ul>
      <li><b>피크 횟수</b>: 밤 시간 중 1시간 최대값이 ${t.peak}dB를 넘은 시간 수 ÷ 밤 수.</li>
      <li><b>주말 효과</b>: 금·토 밤 L<sub>night</sub> − 일~목 밤 L<sub>night</sub>.</li>
      <li><b>밤 밝기</b>: 22~06시 조도 중앙값(lux). 참고선 ${t.lux_ref} lux(서울 주거지역 침입광 기준). 센서가 가로등 바로 아래 있으면 높게 나옵니다.</li>
      <li><b>조용한 밤</b>: 하룻밤 L<sub>night</sub>가 ${t.quiet_night}dB 미만인 날의 비율.</li>
    </ul>

    <h3>5. 수면 점수 (잠정)</h3>
    <ul>
      <li>소음 ${t.score_best}dB 이하 = 100점, ${t.score_worst}dB 이상 = 0점, 그 사이는 직선.</li>
      <li>밤 밝기가 ${t.lux_ref} lux를 넘으면 −5점. 피크 1회/밤마다 −2점(최대 −10점).</li>
      <li>가중치는 팀이 확정하기 전의 <b>잠정값</b>입니다.</li>
    </ul>

    <h3>6. 데이터 정리 (자동)</h3>
    <ul>
      <li>밤 시간 결측률이 30%를 넘는 센서, 소음 값이 기간 내내 똑같은 센서(고장 의심)는 뺍니다. 이번 기간 ${c.excluded_sensors}개.</li>
      <li>하룻밤 8시간 중 6시간 이상 값이 있는 밤만 씁니다.</li>
      <li><b>이상치 제거</b>: 센서마다 평소 밤(중앙값)보다 8dB 이상 높은 밤은 공사·축제·일시 고장으로 보고 기본 통계에서 뺍니다. 이번 기간 ${c.excluded_nights}개 밤. 뺀 내역은 <code>excluded.json</code>에 모두 남깁니다.</li>
    </ul>

    <h3>7. 소음 패턴 자동 분류</h3>
    <p>행정동마다 요일×시간(7×24) 소음 모양을 만들고, 동마다 평균을 빼서 <b>크기가 아니라 모양</b>만 남긴 뒤 k-means로 ${data.patterns.length}개 무리로 나눴습니다. 이름은 무리의 특징(낮−밤 차이, 주말 밤 상승)을 보고 사람이 정한 규칙으로 붙였습니다.</p>
    <ul>${pats}</ul>

    <h3>8. 층간소음 위험 등급 (추정)</h3>
    <p>측정값이 아니라 <b>건축 기준(연식)으로 추정</b>한 등급입니다. 제도는 사업승인일 기준이지만 공개 데이터에는 사용승인일만 있어 2~3년 시차를 감안했습니다.</p>
    <table class="ctable"><thead><tr><th scope="col">등급</th><th scope="col">사용승인일(근사)</th><th scope="col">근거</th></tr></thead><tbody>
      <tr><td>높음</td><td>~2007</td><td>2005-07 이전 사업승인: 슬래브 120~180mm면 통과</td></tr>
      <tr><td>보통</td><td>2008~2016</td><td>2005-07 표준바닥구조 도입 ~ 2014-05 강화 전</td></tr>
      <tr><td>낮음</td><td>2017~</td><td>2014-05 이후: 벽식 210mm·기둥식 150mm 이상 + 충격음 기준</td></tr>
      <tr><td>측정 기준 적용</td><td>2025-08-04~ (2022-08-04 이후 사업승인 근사)</td><td>사후확인제: 완공 후 실측, 49dB 이하</td></tr>
    </tbody></table>
    <p class="hint">건축 시기 기준 추정 등급이며 실제 소음과 다를 수 있습니다. 공동주택관리정보시스템(K-APT)에 등록된 단지만 포함합니다.</p>

    <h3>9. AI를 쓴 곳</h3>
    <ul>
      <li>소음 패턴 분류(k-means)와 이상치 제거는 위에 적은 규칙대로 자동으로 합니다.</li>
      <li>동네 리포트 문장: <b>준비 중</b>. 숫자는 데이터에서 가져오고 AI는 문장만 만들며, 문장 속 숫자가 입력 숫자와 다르면 버립니다.</li>
    </ul>

    <h3>10. 출처</h3>
    <ul>${data.meta.sources.map((s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> — ${s.by}</li>`).join("")}
      <li>배경지도: © OpenStreetMap contributors, OpenFreeMap · 위성 영상: Esri World Imagery (© Esri, Maxar, Earthstar Geographics)</li></ul>
    <p class="hint">S-DoT 데이터를 이용한 개인·팀의 분석 결과이며 서울시의 공식 입장이 아닙니다.</p>
  </article>`;
}
