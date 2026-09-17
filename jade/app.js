// 翡翠麻将馆 · Jade Mahjong skin: labels, flavour text, seal stamps and effects over the shared skin runtime.
import { mountSkin } from '../shared/skin.js?v=server-wheel-77-v13-20260917-bb95541d1aed';
mountSkin({
  navSelector: '.drawer-nav',
  startLabel: '开转',
  customLabel: '自定',
  longAfter: 9,
  longerAfter: 11,
  spinningMessage: '转盘转动中…',
  flavor: { jackpot: '大满贯', bonus: '鸿运当头', win: '小胡一把', even: '和局', loss: '小亏一手', empty: '谢谢参与' },
  stamp: { jackpot: '大奖', bonus: '胡了', win: '胡了', even: '退本', loss: '金元宝', empty: '金元宝' },
  celebrate(kind, round, { stage, sound, particles, haptic }) {
    const tiles = ['#b3261e', '#2f8f66', '#1c3b2e'];
    if (kind === 'jackpot') {
      sound.jackpot(); haptic([60, 40, 60, 40, 140]); stage.classList.add('result-win');
      particles({ colors: tiles, count: 150, shapes: ['tile'], duration: 3600, power: 1.2, origin: { x: .5, y: .35 } });
      setTimeout(() => particles({ colors: ['#f2cf7a', '#d9a441'], count: 120, shapes: ['ingot', 'circle'], origin: { x: .3, y: .3 } }), 500);
      setTimeout(() => particles({ colors: ['#f2cf7a', '#b3261e'], count: 120, shapes: ['star', 'rect'], origin: { x: .7, y: .3 } }), 950);
    } else if (kind === 'bonus') { sound.win(); haptic([40, 30, 90]); stage.classList.add('result-win'); particles({ colors: tiles, count: 110, shapes: ['tile', 'circle'], origin: { x: .5, y: .38 } }); }
    else if (kind === 'win') { sound.win(); haptic(40); stage.classList.add('result-win'); particles({ colors: ['#b3261e', '#f2cf7a'], count: 70, shapes: ['tile', 'circle'], origin: { x: .5, y: .4 }, power: .8 }); }
    else if (kind === 'even') { sound.refund(); haptic(20); stage.classList.add('result-even'); }
    else { stage.classList.add('result-loss'); if (Number(round.ingots) > 0) { sound.ingot(); particles({ mode: 'rain', colors: ['#f2cf7a', '#d9a441'], count: 26, shapes: ['ingot'], duration: 2800 }); } else sound.lose(); haptic(30); }
  },
});
