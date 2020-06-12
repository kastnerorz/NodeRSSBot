import {
    getSubscribersByFeedId,
    deleteSubscribersByUserId
} from '../proxies/subscribes';
import logger from './logger';
import sanitize from './sanitize';
import { config } from '../config';
import Telegraf, { Context } from 'telegraf';
import { Feed, FeedItem } from '../types/feed';
import { getUserById, migrateUser } from '../proxies/users';
import { isNone } from '../types/option';
import {
    InputMediaPhoto,
    InputMediaVideo
} from 'telegraf/typings/telegram-types';

/**
 * handle send error log or delete user or migrate user
 * @param e the error that handle
 * @param userId user_id that this error occur
 * @return whether to send again
 */
async function handlerSendError(e: any, userId: number): Promise<boolean> {
    // bot was blocked or chat is deleted
    logger.error(e.description);
    const re = new RegExp(
        'chat not found|bot was blocked by the user|bot was kicked'
    );
    if (config.delete_on_err_send && re.test(e.description)) {
        logger.error(`delete all subscribes for user ${userId}`);
        deleteSubscribersByUserId(userId);
    }
    if (
        e.description ===
        'Bad Request: group chat was upgraded to a supergroup chat'
    ) {
        const from = userId;
        const to = e.parameters.migrate_to_chat_id;
        const user = await getUserById(to);
        if (isNone(user)) {
            await migrateUser(from, to);
            return true;
        } else {
            deleteSubscribersByUserId(from);
        }
    }
    return false;
}

async function sendMediaGroup(
    bot: Telegraf<Context>,
    userId: number,
    mediaGroup: InputMediaPhoto[] | InputMediaVideo[]
) {
    try {
        await bot.telegram.sendMediaGroup(userId, mediaGroup);
    } catch (e) {
        const resend = handlerSendError(e, userId);
        if (resend && e.parameters?.migrate_to_chat_id) {
            await bot.telegram.sendMediaGroup(
                e.parameters.migrate_to_chat_id,
                mediaGroup
            );
        }
    }
}

async function sendMessage(
    bot: Telegraf<Context>,
    userId: number,
    text: string
) {
    try {
        await bot.telegram.sendMessage(userId, text, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (e) {
        const resend = handlerSendError(e, userId);
        if (resend && e.parameters?.migrate_to_chat_id) {
            await bot.telegram.sendMessage(
                e.parameters.migrate_to_chat_id,
                text,
                {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }
            );
        }
    }
}

const send = async (
    bot: Telegraf<Context>,
    toSend: NonNullable<string | FeedItem[]>,
    feed: Feed
) => {
    const subscribers = await getSubscribersByFeedId(feed.feed_id);
    if (typeof toSend === 'string') {
        subscribers.map(async (subscribe) => {
            const userId = subscribe.user_id;
            try {
                await bot.telegram.sendMessage(userId, toSend, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            } catch (e) {
                handlerSendError(e, userId);
            }
        });
    } else {
        if (/即刻/g.test(feed.feed_title)) {
            subscribers.map(async (subscribe) => {
                const userId = subscribe.user_id;
                const username = /(.*)的即刻动态/g.exec(feed.feed_title);
                if (username[1] == '') {
                    username[1] = '即友';
                }
                toSend.forEach(async (item) => {
                    if (/<img ref/g.test(item.content)) {
                        const mediaGroup: InputMediaPhoto[] = [];
                        const re = /<img referrerpolicy="no-referrer" src="(https:\/\/cdn\.jellow\.site\/[a-z|A-Z|0-9|\-|_]*\.(?:jpe?g|png))\?/g;
                        let m: RegExpExecArray;
                        do {
                            m = re.exec(item.content);
                            if (m) {
                                mediaGroup.push({
                                    type: 'photo',
                                    media: m[1]
                                });
                            }
                        } while (m);
                        if (mediaGroup.length > 0) {
                            item.content = item.content.substring(
                                0,
                                /<br><br>/g.exec(item.content).index
                            );
                            item.content = item.content.replace(/<br>/g, '\n');
                            const caption = `<b>${username[1]}</b>\n${item.content}`;
                            const link = `\n<a href="${item.link}">去看看</a>`;
                            if (caption.length >= 200) {
                                mediaGroup[0].caption =
                                    caption.substring(0, 190) + '...\n' + link;
                            } else {
                                mediaGroup[0].caption = caption + '\n' + link;
                            }
                            mediaGroup[0].parse_mode = 'html';
                            await sendMediaGroup(bot, userId, mediaGroup);
                        } else {
                            item.content = item.content.substring(
                                0,
                                /<br><br>/g.exec(item.content).index
                            );
                            item.content = item.content.replace(/<br>/g, '\n');
                            let caption = `<b>${username[1]}</b>\n${item.content}`;
                            const link = `\n<a href="${item.link}">去看看</a>`;
                            if (caption.length >= 200) {
                                caption =
                                    caption.substring(0, 190) + '...\n' + link;
                            } else {
                                caption = caption + '\n' + link;
                            }
                            await sendMessage(bot, userId, caption);
                        }
                    } else {
                        item.content = item.content.substring(
                            0,
                            /<br><br>/g.exec(item.content).index
                        );
                        item.content = item.content.replace(/<br>/g, '\n');
                        let caption = `<b>${username[1]}</b>\n${item.content}`;
                        const link = `\n<a href="${item.link}">去看看</a>`;
                        if (caption.length >= 200) {
                            caption =
                                caption.substring(0, 190) + '...\n' + link;
                        } else {
                            caption = caption + '\n' + link;
                        }
                        await sendMessage(bot, userId, caption);
                    }
                });
            });
        } else {
            subscribers.map(async (subscribe) => {
                const userId = subscribe.user_id;
                let text = `<b>${sanitize(feed.feed_title)}</b>`;
                toSend.forEach(function (item) {
                    text += `\n<a href="${item.link.trim()}">${sanitize(
                        item.title
                    )}</a>`;
                });
                try {
                    await bot.telegram.sendMessage(userId, text, {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    });
                } catch (e) {
                    const resend = handlerSendError(e, userId);
                    if (resend && e.parameters?.migrate_to_chat_id) {
                        await bot.telegram.sendMessage(
                            e.parameters.migrate_to_chat_id,
                            text,
                            {
                                parse_mode: 'HTML',
                                disable_web_page_preview: true
                            }
                        );
                    }
                }
            });
        }
    }
};

export default send;
