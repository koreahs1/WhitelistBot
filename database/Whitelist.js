const mongoose = require('mongoose');

const whitelistSchema = new mongoose.Schema({
    creatorType: { type: String, enum: ["user", "group"], required: true },
    userId: { type: String, required: true, unique: true },
    verified: { type: Boolean, default: false },
    dateAdded: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Whitelist', whitelistSchema);
