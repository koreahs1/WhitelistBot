require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Slash Command Definition
const commands = [
    new SlashCommandBuilder()
        .setName('화이트리스트')
        .setDescription('화이트리스트 관리 명령어입니다.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('등록')
                .setDescription('화이트리스트에 로블록스 유저/그룹을 등록합니다.')
                .addStringOption(option =>
                    option.setName('type')
                        .setDescription('등록할 타입 (user 또는 group)')
                        .setRequired(true)
                        .addChoices(
                            { name: '유저', value: 'user' },
                            { name: '그룹', value: 'group' }
                        )
                )
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('로블록스 유저 ID 또는 그룹 ID')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('확인')
                .setDescription('화이트리스트 등록 여부를 확인합니다.')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('로블록스 유저 ID 또는 그룹 ID')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('삭제')
                .setDescription('화이트리스트에서 로블록스 유저/그룹을 삭제합니다. (관리자 전용)')
                .addStringOption(option =>
                    option.setName('id')
                        .setDescription('로블록스 유저 ID 또는 그룹 ID')
                        .setRequired(true)
                )
        )
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const formatType = (type) => type === 'user' ? '유저' : type === 'group' ? '그룹' : type;

// Cloudflare Worker 통신용 유틸리티 함수
const workerRequest = async (method, path, body = null) => {
    const url = `${process.env.WORKER_URL}${path}`;
    const options = {
        method,
        headers: {
            'Authorization': process.env.WORKER_API_KEY,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json();
    return { status: response.status, data };
};

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    try {
        console.log('Started refreshing application (/) commands.');
        // 전역으로 슬래시 명령어 등록
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error refreshing commands:', error);
    }
});

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isButton()) {
        const originalEmbed = interaction.message.embeds[0];

        // 임베드 필드에서 요청자 디스코드 ID와 로블록스 ID 추출
        const requesterFieldValue = originalEmbed.fields.find(f => f.name === '요청 유저')?.value;
        const requesterId = requesterFieldValue?.match(/\d+/)?.[0];

        const robloxIdFieldValue = originalEmbed.fields.find(f => f.name === '로블록스 ID')?.value;
        const robloxId = robloxIdFieldValue?.replace(/`/g, '');

        if (interaction.customId.startsWith('approve_')) {
            const documentId = interaction.customId.replace('approve_', '');

            try {
                // Worker API 호출: DB 업데이트
                const res = await workerRequest('PATCH', `/admin?id=${documentId}`);
                const updatedData = res.status === 200 ? res.data.data : null;

                if (updatedData) {
                    console.log(`[승인] 화이트리스트 등록 승인: ID ${updatedData.userId} (승인자: ${interaction.user.tag})`);
                    // 임베드 업데이트
                    const updatedEmbed = EmbedBuilder.from(originalEmbed)
                        .setTitle('✅ 화이트리스트 등록 승인 완료')
                        .setColor(0x00FF00) // 초록색
                        .addFields({ name: '처리자', value: `<@${interaction.user.id}>`, inline: false });

                    // 메시지 수정 (버튼 제거)
                    await interaction.update({ embeds: [updatedEmbed], components: [] });

                    // 유저에게 DM 전송
                    if (requesterId) {
                        try {
                            const user = await client.users.fetch(requesterId);
                            await user.send(`🎉 **화이트리스트 등록 승인 안내**\n요청하신 로블록스 ID(\`${updatedData.userId}\`)의 화이트리스트 등록이 승인되었습니다!`);
                        } catch (dmError) {
                            console.error('DM 전송 실패:', dmError.message);
                        }
                    }
                } else {
                    await interaction.reply({ content: '데이터베이스에서 해당 정보를 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
                }
            } catch (error) {
                console.error('Approval Error:', error);
                await interaction.reply({ content: '승인 처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral });
            }
        } else if (interaction.customId.startsWith('reject_')) {
            try {
                // Worker API 호출: DB 삭제
                const res = await workerRequest('DELETE', `/delete?id=${robloxId}`);
                const deletedData = res.status === 200 ? res.data.data : null;

                if (deletedData) {
                    console.log(`[거부] 화이트리스트 등록 거부: ID ${deletedData.userId} (거부자: ${interaction.user.tag})`);
                    // 임베드 업데이트
                    const updatedEmbed = EmbedBuilder.from(originalEmbed)
                        .setTitle('❌ 화이트리스트 등록 거부됨')
                        .setColor(0xFF0000) // 빨간색
                        .addFields({ name: '처리자', value: `<@${interaction.user.id}>`, inline: false });

                    // 메시지 수정 (버튼 제거)
                    await interaction.update({ embeds: [updatedEmbed], components: [] });

                    // 유저에게 DM 전송
                    if (requesterId) {
                        try {
                            const user = await client.users.fetch(requesterId);
                            await user.send(`🚫 **화이트리스트 등록 거부 안내**\n요청하신 로블록스 ID(\`${deletedData.userId}\`)의 화이트리스트 등록이 관리자에 의해 거부되었습니다.`);
                        } catch (dmError) {
                            console.error('DM 전송 실패:', dmError.message);
                        }
                    }
                } else {
                    await interaction.reply({ content: '데이터베이스에서 해당 정보를 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
                }
            } catch (error) {
                console.error('Rejection Error:', error);
                await interaction.reply({ content: '거부 처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral });
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === '화이트리스트') {
        // 허용된 서버 필터링
        const isTestMode = process.env.TEST_MODE === 'true';
        const testServerId = process.env.DISCORD_TEST_SERVER;
        const allowedServers = (process.env.ALLOWED_SERVERS || '').split(' ').filter(id => id.trim() !== '');

        if (isTestMode) {
            if (interaction.guildId !== testServerId) {
                return interaction.reply({ content: '현재 테스트 모드입니다. 테스트 서버에서만 명령어를 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
            }
        } else {
            if (!allowedServers.includes(interaction.guildId)) {
                return interaction.reply({ content: '이 서버에서는 이 명령어를 사용할 권한이 없습니다.', flags: MessageFlags.Ephemeral });
            }
        }

        const subcommand = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            if (subcommand === '등록') {
                const type = interaction.options.getString('type');
                const id = interaction.options.getString('id');

                // Worker API 호출: 중복 등록 확인 및 데이터베이스 저장
                const res = await workerRequest('POST', '/post/', { creatorType: type, userId: id });

                if (res.status === 409) {
                    const existing = res.data.existing;
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ 등록 실패')
                        .setDescription(`이미 등록된 로블록스 ID입니다: \`${id}\``)
                        .addFields({ name: '종류', value: formatType(existing.creatorType), inline: true })
                        .setColor(0xFF0000);
                    return interaction.editReply({ embeds: [embed] });
                } else if (res.status !== 200) {
                    throw new Error('Worker API Error: ' + res.data.error);
                }

                const newWhitelist = res.data.data;
                console.log(`[요청] 화이트리스트 등록 요청: ID ${id}, 종류 ${type} (요청자: ${interaction.user.tag})`);

                // 로그 채널에 메시지 전송
                const logChannelId = process.env.DISCORD_LOG_CHANNEL;
                if (logChannelId) {
                    const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
                    if (logChannel) {
                        const embed = new EmbedBuilder()
                            .setTitle('새로운 화이트리스트 등록 요청')
                            .addFields(
                                { name: '요청 유저', value: `<@${interaction.user.id}>`, inline: true },
                                { name: '로블록스 ID', value: `\`${id}\``, inline: true },
                                { name: '종류', value: formatType(type), inline: true }
                            )
                            .setColor(0xFFA500) // 주황색
                            .setTimestamp();

                        const row = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`approve_${newWhitelist._id}`)
                                    .setLabel('등록 승인')
                                    .setStyle(ButtonStyle.Success),
                                new ButtonBuilder()
                                    .setCustomId(`reject_${newWhitelist._id}`)
                                    .setLabel('등록 거부')
                                    .setStyle(ButtonStyle.Danger)
                            );

                        await logChannel.send({ embeds: [embed], components: [row] });
                    }
                }

                const replyEmbed = new EmbedBuilder()
                    .setTitle('📝 화이트리스트 등록 요청 완료')
                    .setDescription(`성공적으로 화이트리스트 등록이 요청되었습니다.\n*(관리자 승인 대기 중)*`)
                    .addFields(
                        { name: '로블록스 ID', value: `\`${id}\``, inline: true },
                        { name: '종류', value: formatType(type), inline: true }
                    )
                    .setColor(0x00BFFF);
                return interaction.editReply({ embeds: [replyEmbed] });

            } else if (subcommand === '확인') {
                const id = interaction.options.getString('id');

                const res = await workerRequest('GET', `/?id=${id}`);
                const data = res.status === 200 ? res.data.data : null;

                if (data) {
                    const status = data.verified ? '✅ 인증됨(Verified)' : '⏳ 대기중(Not Verified)';
                    const embed = new EmbedBuilder()
                        .setTitle('🔍 화이트리스트 확인')
                        .setDescription(`\`${id}\`는 화이트리스트에 **등록되어 있습니다**.`)
                        .addFields(
                            { name: '종류', value: formatType(data.creatorType), inline: true },
                            { name: '상태', value: status, inline: true },
                            { name: '등록일', value: data.dateAdded.toLocaleString(), inline: false }
                        )
                        .setColor(data.verified ? 0x00FF00 : 0xFFA500);
                    return interaction.editReply({ embeds: [embed] });
                } else {
                    const embed = new EmbedBuilder()
                        .setTitle('🔍 화이트리스트 확인')
                        .setDescription(`\`${id}\`는 화이트리스트에 **등록되어 있지 않습니다**.`)
                        .setColor(0xFF0000);
                    return interaction.editReply({ embeds: [embed] });
                }
            } else if (subcommand === '삭제') {
                // 관리자 권한 확인
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    const embed = new EmbedBuilder()
                        .setTitle('🚫 권한 부족')
                        .setDescription('이 명령어를 사용할 권한이 없습니다. (관리자 권한 필요)')
                        .setColor(0xFF0000);
                    return interaction.editReply({ embeds: [embed] });
                }

                const id = interaction.options.getString('id');

                const res = await workerRequest('DELETE', `/delete?id=${id}`);
                const deletedData = res.status === 200 ? res.data.data : null;

                if (deletedData) {
                    console.log(`[삭제] 화이트리스트 삭제: ID ${id} (삭제자: ${interaction.user.tag})`);

                    // 로그 채널에 알림
                    const logChannelId = process.env.DISCORD_LOG_CHANNEL;
                    if (logChannelId) {
                        const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
                        if (logChannel) {
                            const embed = new EmbedBuilder()
                                .setTitle('🗑️ 화이트리스트 삭제')
                                .addFields(
                                    { name: '삭제자', value: `<@${interaction.user.id}>`, inline: true },
                                    { name: '로블록스 ID', value: `\`${id}\``, inline: true },
                                    { name: '종류', value: formatType(deletedData.creatorType), inline: true }
                                )
                                .setColor(0xFF0000)
                                .setTimestamp();
                            await logChannel.send({ embeds: [embed] });
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('🗑️ 화이트리스트 삭제 완료')
                        .setDescription(`성공적으로 화이트리스트에서 삭제되었습니다.`)
                        .addFields(
                            { name: '로블록스 ID', value: `\`${id}\``, inline: true },
                            { name: '종류', value: formatType(deletedData.creatorType), inline: true }
                        )
                        .setColor(0x00FF00);
                    return interaction.editReply({ embeds: [embed] });
                } else {
                    const embed = new EmbedBuilder()
                        .setTitle('❌ 삭제 실패')
                        .setDescription(`\`${id}\`는 화이트리스트에 등록되어 있지 않습니다.`)
                        .setColor(0xFF0000);
                    return interaction.editReply({ embeds: [embed] });
                }
            }
        } catch (error) {
            console.error('Command Execution Error:', error);
            return interaction.editReply('명령어 처리 중 오류가 발생했습니다.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
