import mongoose from 'mongoose';

const OwnerSchema = new mongoose.Schema({
    ownerName: { type: String, required: true },
    ownerNumber: { type: String, required: true, unique: true },
    businessName: { type: String, default: "Stany Max Hub Business" },
    businessLogo: { type: String, default: "" }, // URL ya picha
    welcomeMessage: { type: String, default: "Karibu kwenye kituo chetu cha huduma!" },
    
    // Mipangilio ya group
    groupEnabled: { type: Boolean, default: false }, // Je bot inafanya kazi kwenye groups?
    groupTag: { type: String, default: "" }, // Tag ya bot kwenye group (mfano: @stany_bot)
    
    // Saa za kazi
    workingHoursStart: { type: String, default: "08:00" }, // Mfano: "08:00"
    workingHoursEnd: { type: String, default: "18:00" },   // Mfano: "18:00"
    
    services: [
        {
            keyword: { type: String, required: true },
            name: { type: String, required: true },
            description: { type: String, required: true },
            price: { type: String, required: true },
            imageUrl: { type: String, default: "" }
        }
    ]
});

export const Owner = mongoose.model('Owner', OwnerSchema);