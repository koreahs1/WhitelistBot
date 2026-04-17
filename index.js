require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const mongoose = require('mongoose');
const Whitelist = require('./database/Whitelist');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.error('MongoDB Connection Error:', err));

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
        if (interaction.customId.startsWith('approve_')) {
            const documentId = interaction.customId.replace('approve_', '');

            try {
                // DB 업데이트
                const updatedData = await Whitelist.findByIdAndUpdate(documentId, { verified: true }, { returnDocument: 'after' });

                if (updatedData) {
                    console.log(`[승인] 화이트리스트 등록 승인: ID ${updatedData.userId} (승인자: ${interaction.user.tag})`);
                    // 임베드 업데이트
                    const originalEmbed = interaction.message.embeds[0];
                    const updatedEmbed = EmbedBuilder.from(originalEmbed)
                        .setTitle('✅ 화이트리스트 등록 완료')
                        .setColor(0x00FF00) // 초록색
                        .addFields({ name: '승인자', value: `<@${interaction.user.id}>`, inline: false });

                    // 메시지 수정 (버튼 제거)
                    await interaction.update({ embeds: [updatedEmbed], components: [] });
                } else {
                    await interaction.reply({ content: '데이터베이스에서 해당 정보를 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
                }
            } catch (error) {
                console.error('Approval Error:', error);
                await interaction.reply({ content: '승인 처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral });
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

                // 중복 등록 확인
                const existing = await Whitelist.findOne({ userId: id });
                if (existing) {
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ 등록 실패')
                        .setDescription(`이미 등록된 로블록스 ID입니다: \`${id}\``)
                        .addFields({ name: '종류', value: formatType(existing.creatorType), inline: true })
                        .setColor(0xFF0000);
                    return interaction.editReply({ embeds: [embed] });
                }

                // 데이터베이스 저장
                const newWhitelist = new Whitelist({
                    creatorType: type,
                    userId: id,
                    // verified는 스키마의 default(false)를 따름
                });

                await newWhitelist.save();
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
                                    .setStyle(ButtonStyle.Success)
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

                const data = await Whitelist.findOne({ userId: id });
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

                const deletedData = await Whitelist.findOneAndDelete({ userId: id });
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
