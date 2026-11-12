import { Engine } from './engine.mjs';
import { message } from '../shared/i18n.mjs';

export function createDemo(count = 10) {
  const engine = new Engine({ demo: true, loader: async (a, folder, limit) => {
    await new Promise(resolve => setTimeout(resolve, 900));
    return { validity: 'demo', messages: demoMessages(a.id, folder).slice(0, limit) };
  } });
  populateDemo(engine, count);
  return engine;
}

export function populateDemo(engine, count) {
  if (!engine.demo || ![10, 100, 500].includes(count)) throw new Error('Invalid demo population');
  engine.queue = [];
  engine.lastBatch = null;
  engine.accounts.clear();
  for (let index = 0; index < count; index++) {
    const address = `reader.${String(index + 1).padStart(3, '0')}@outlook.example`;
    const id = `demo-${index + 1}`;
    const populated = index < 12;
    engine.accounts.set(id, { id, email: address, label: index < 3 ? ['Рабочая почта', 'Личные письма', 'Команда студии'][index] : '', group: ['Работа', 'Личное', 'Проекты', 'Архив'][index % 4], note: '', favorite: index < 3 || index % 10 === 0, clientId: '', enabled: true, userPaused: false, status: populated ? 'ok' : 'idle', lastSync: populated ? Date.now() - (index + 1) * 45000 : 0, nextAllowed: 0, cache: populated ? { inbox: { validity: 'demo', version: String(Date.now()), messages: demoMessages(id, 'inbox') }, junk: { validity: 'demo', messages: [] } } : {} });
  }
  engine.log(message('log.demo', { count }));
}

function demoMessages(accountId, folder) {
  if (folder === 'junk') return [];
  const content = [
    ['Microsoft', 'account-security-noreply@accountprotection.microsoft.com', 'Ваш код безопасности', 'Код безопасности: 482716\n\nИспользуйте этот код для подтверждения входа в вашу учётную запись Microsoft.\n\nЕсли вы не запрашивали этот код, проверьте активность учётной записи. Никому не сообщайте этот код.\n\nКоманда учётных записей Microsoft', ['482716'], [], true],
    ['Notion', 'notify@example.com', 'Ваши заметки за неделю', 'Добрый день!\n\nНа этой неделе вы создали 4 страницы и завершили 8 задач. Самое время освободить место для новых идей.\n\nХорошей недели!\nКоманда заметок', [], [], false],
    ['Linear', 'notifications@example.com', 'Подтвердите адрес электронной почты', 'Подтвердите адрес электронной почты, чтобы присоединиться к рабочему пространству.\n\nhttps://example.com/confirm?token=demo-only\n\nЭта ссылка приведена только для демонстрации интерфейса.', [], ['https://example.com/confirm?token=demo-only'], true],
    ['GitHub', 'noreply@example.com', 'Код подтверждения входа', 'Ваш код подтверждения: 938204\n\nВведите его, чтобы завершить вход. Если это были не вы, измените пароль.', ['938204'], [], true],
    ['Figma', 'updates@example.com', 'Новый комментарий к макету', 'Мария оставила комментарий:\n\n«Проверила экран входа. Теперь всё читается гораздо лучше. Можно передавать в разработку».', [], [], false],
    ['Команда', 'team@example.com', 'Планы на следующую неделю', 'Привет!\n\nВ понедельник посмотрим на результаты тестирования и обсудим следующие шаги.\n\nПовестка:\n• проверка нового интерфейса;\n• обратная связь;\n• подготовка следующей версии.\n\nДо встречи!', [], [], false]
  ];
  return content.map(([name, address, subject, text, codes, links, unread], index) => ({
    id: `${accountId}-${index}`, uid: index + 1, from: `${name} <${address}>`, subject, text, codes, links, unread,
    date: new Date(Date.now() - index * 2400000 - 120000).toISOString(), preview: text.replace(/\s+/g, ' ').slice(0, 160)
  }));
}
