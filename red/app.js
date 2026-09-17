// 红运当头 · Red Fortune skin: labels, flavour text, seal stamps and effects over the shared skin runtime.
import { mountSkin } from '../shared/skin.js?v=server-wheel-77-v13-20260917-bb95541d1aed';
mountSkin({
  navSelector: '.plaques',
  spinningMessage: '好彩头转起来…',
  flavor: { jackpot: '鸿运当头', bonus: '财源滚滚', win: '小有进账', even: '本金退回', loss: '稍有损失', empty: '谢谢参与' },
  stamp: { jackpot: '大吉大利', bonus: '大吉', win: '吉', even: '平', loss: '金元宝', empty: '金元宝' },
  celebrate(kind, round, { stage, sound, particles, haptic }) {
    const gold = ['#ffd166', '#fff3b0', '#f0b93a'], red = ['#ff4d4d', '#c8102e'];
    if (kind === 'jackpot') {
      sound.jackpot(); haptic([60, 40, 60, 40, 140]); stage.classList.add('result-win');
      particles({ colors: [...gold, ...red, '#fff4dc'], count: 240, shapes: ['circle', 'rect', 'star'], duration: 3800, power: 1.3, origin: { x: .5, y: .35 } });
      setTimeout(() => particles({ colors: gold, count: 120, shapes: ['circle', 'star'], origin: { x: .25, y: .3 } }), 500);
      setTimeout(() => particles({ colors: [...red, '#ffd166'], count: 120, shapes: ['rect', 'star'], origin: { x: .75, y: .3 } }), 950);
    } else if (kind === 'bonus') { sound.win(); haptic([40, 30, 90]); stage.classList.add('result-win'); particles({ colors: [...gold, '#ff4d4d'], count: 170, shapes: ['circle', 'rect', 'star'], origin: { x: .5, y: .38 } }); }
    else if (kind === 'win') { sound.win(); haptic(40); stage.classList.add('result-win'); particles({ colors: gold, count: 100, shapes: ['circle', 'star'], origin: { x: .5, y: .4 }, power: .8 }); }
    else if (kind === 'even') { sound.refund(); haptic(20); stage.classList.add('result-even'); }
    else { stage.classList.add('result-loss'); if (Number(round.ingots) > 0) { sound.ingot(); particles({ mode: 'rain', colors: ['#ffd166', '#f0b93a'], count: 26, shapes: ['ingot'], duration: 2800 }); } else sound.lose(); haptic(30); }
  },
});
