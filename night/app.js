// 福运夜市 · Night Market skin: labels, flavour text and effects over the shared skin runtime.
import { mountSkin } from '../shared/skin.js?v=server-wheel-77-v13-20260917-f2a9573e22c3';
mountSkin({
  navSelector: '.stalls',
  flavor: { jackpot: '大奖来了', bonus: '鸿运当头', win: '小有收获', even: '本金退回', loss: '稍有损失', empty: '谢谢参与' },
  celebrate(kind, round, { stage, sound, particles, haptic }) {
    if (kind === 'jackpot') {
      sound.jackpot(); haptic([60, 40, 60, 40, 140]); stage.classList.add('result-win');
      particles({ colors: ['#ffd166', '#ff4b4b', '#fff4d6', '#ffa94d'], count: 220, shapes: ['rect', 'circle', 'star'], duration: 3600, power: 1.3, origin: { x: .5, y: .35 } });
      setTimeout(() => particles({ colors: ['#ffd166', '#ffffff'], count: 120, shapes: ['star', 'circle'], origin: { x: .28, y: .3 } }), 500);
      setTimeout(() => particles({ colors: ['#ff4b4b', '#ffd166'], count: 120, shapes: ['rect', 'star'], origin: { x: .72, y: .3 } }), 950);
    } else if (kind === 'bonus') { sound.win(); haptic([40, 30, 90]); stage.classList.add('result-win'); particles({ colors: ['#ffd166', '#ff4b4b', '#fff4d6'], count: 160, shapes: ['rect', 'circle', 'star'], origin: { x: .5, y: .38 } }); }
    else if (kind === 'win') { sound.win(); haptic(40); stage.classList.add('result-win'); particles({ colors: ['#ffd166', '#fff4d6'], count: 90, shapes: ['circle', 'star'], origin: { x: .5, y: .4 }, power: .8 }); }
    else if (kind === 'even') { sound.refund(); haptic(20); stage.classList.add('result-even'); }
    else { stage.classList.add('result-loss'); if (Number(round.ingots) > 0) { sound.ingot(); particles({ mode: 'rain', colors: ['#ffd166', '#f0b93a'], count: 26, shapes: ['ingot'], duration: 2800 }); } else sound.lose(); haptic(30); }
  },
});
